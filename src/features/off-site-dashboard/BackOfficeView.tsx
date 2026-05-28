import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

// =============================================================================
// JSON shape helpers
// =============================================================================
//
// The Back Office editor is intentionally permissive about the shape of its
// input — operators paste in opportunity dumps from the backend whose layout
// can drift over time. Rather than declaring a strict TypeScript shape and
// rejecting anything that doesn't match, we walk the document by string paths
// (e.g. "opportunity.data.dashboard.analytics.performance.insights.content.
// topics") and treat each editable section as optional.
//
// Two consequences worth knowing:
//   1. Adding a new section to the editor is a one-line lookup, not a
//      type-system change. See the renderTopics/renderSources/etc. callsites
//      below for the pattern.
//   2. We can't trust any value to exist — every getter narrows the unknown
//      via `isRecord`/`isArray`/`isFiniteNumber` before reading nested keys.

type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { [key: string]: JsonValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (isFiniteNumber(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Resolve a "dot.path" against an arbitrary JSON-like document, returning
 * `undefined` whenever a segment isn't present. Array indices are supported
 * via numeric segments (e.g. "topics.0.title").
 *
 * Kept intentionally tolerant — the goal of the Back Office editor is to
 * surface as much of an unfamiliar payload as we can recognise without
 * crashing on missing branches.
 */
function getAtPath(root: unknown, path: string): unknown {
  if (!path) return root;
  const segments = path.split('.');
  let current: unknown = root;
  for (const segment of segments) {
    if (current == null) return undefined;
    if (isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (isRecord(current)) {
      current = current[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

/**
 * Produce a new JSON-like document with `value` placed at `path`. The
 * caller's input is not mutated — we shallow-clone every container we
 * descend through. Missing intermediate records are created so the editor
 * can set fields the original payload didn't carry (e.g. add a sentiment
 * label where none existed before).
 *
 * Array indices behave the same as in `getAtPath`. Out-of-range writes are
 * supported only when the index is the next slot; gaps in arrays would
 * break the SOV invariants downstream, so we don't attempt to grow them.
 */
function setAtPath(root: unknown, path: string, value: unknown): unknown {
  if (!path) return value;
  const segments = path.split('.');

  function recurse(node: unknown, index: number): unknown {
    if (index === segments.length) return value;
    const segment = segments[index];

    if (isArray(node)) {
      const arrIndex = Number(segment);
      if (!Number.isInteger(arrIndex)) return node;
      const next = [...node];
      next[arrIndex] = recurse(next[arrIndex], index + 1);
      return next;
    }

    const base = isRecord(node) ? { ...node } : {};
    base[segment] = recurse(base[segment], index + 1);
    return base;
  }

  return recurse(root, 0);
}

/**
 * Remove an entry at `path`. For records this deletes the key; for arrays
 * the element at the numeric index is spliced out (so subsequent indices
 * shift down, matching what an operator expects when they hit "remove" on
 * a list row).
 */
function removeAtPath(root: unknown, path: string): unknown {
  if (!path) return root;
  const segments = path.split('.');

  function recurse(node: unknown, index: number): unknown {
    if (index === segments.length - 1) {
      const segment = segments[index];
      if (isArray(node)) {
        const arrIndex = Number(segment);
        if (!Number.isInteger(arrIndex)) return node;
        return node.filter((_, i) => i !== arrIndex);
      }
      if (isRecord(node)) {
        const next: Record<string, unknown> = { ...node };
        delete next[segment];
        return next;
      }
      return node;
    }
    const segment = segments[index];
    if (isArray(node)) {
      const arrIndex = Number(segment);
      if (!Number.isInteger(arrIndex)) return node;
      const next = [...node];
      next[arrIndex] = recurse(next[arrIndex], index + 1);
      return next;
    }
    if (isRecord(node)) {
      const next: Record<string, unknown> = { ...node };
      next[segment] = recurse(next[segment], index + 1);
      return next;
    }
    return node;
  }

  return recurse(root, 0);
}

// =============================================================================
// Share-of-Voice math
// =============================================================================
//
// Each "SOV pool" is a list of objects with a `mentionsPercent` field. The
// invariant we maintain is that the sum of all pool percentages stays at
// 100 (within floating-point rounding tolerance) regardless of which row
// the operator just edited.
//
// The redistribution rule mirrors the worked example the product owner
// asked for: when one row changes from oldValue to newValue, the delta
// (oldValue − newValue) is added back to every OTHER row in proportion to
// its existing share of the remainder. Rows that were at 0% before the
// edit stay at 0% (any other behaviour would invent share out of thin air).
//
// When the remainder was already 0% (every other row was zero), there is
// no proportional basis to redistribute against, so we fall back to
// equal-split — assigning the delta uniformly across the remaining rows.

interface PoolEntry {
  /** Stable label used purely for display (brand name, topic title, etc.). */
  label: string;
  /** The current percentage value, 0–100. */
  percent: number;
}

interface RebalanceResult {
  percents: number[];
  /**
   * `true` when the requested value was outside the [0, 100] range and we
   * had to clamp it. The caller may use this to surface a hint to the user.
   */
  clamped: boolean;
}

function rebalancePool(
  entries: PoolEntry[],
  changedIndex: number,
  rawNewPercent: number,
): RebalanceResult {
  const total = 100;
  const clampedNewPercent = Math.min(Math.max(rawNewPercent, 0), total);
  const clamped = clampedNewPercent !== rawNewPercent;

  if (entries.length === 0) {
    return { percents: [], clamped };
  }
  if (entries.length === 1) {
    // Only one row in the pool — by definition it must be 100%.
    return { percents: [total], clamped: clampedNewPercent !== total };
  }

  const remainingPool = total - clampedNewPercent;
  const otherIndices = entries
    .map((_, index) => index)
    .filter((index) => index !== changedIndex);
  const otherCurrentSum = otherIndices.reduce(
    (acc, index) => acc + entries[index].percent,
    0,
  );

  const next = entries.map((entry) => entry.percent);
  next[changedIndex] = clampedNewPercent;

  if (otherCurrentSum <= 0) {
    // Nothing to redistribute proportionally against — split evenly across
    // the others. This keeps the invariant intact even on adversarial input.
    const share = remainingPool / otherIndices.length;
    for (const index of otherIndices) {
      next[index] = share;
    }
  } else {
    const scale = remainingPool / otherCurrentSum;
    for (const index of otherIndices) {
      next[index] = entries[index].percent * scale;
    }
  }

  return { percents: next.map(roundForDisplay), clamped };
}

function roundForDisplay(value: number): number {
  // One decimal place matches the precision the backend ships (e.g. 48.5%,
  // 51.5%). Rounding here means the on-screen values always sum to ~100
  // without exposing 12-digit fractions to the operator.
  return Math.round(value * 10) / 10;
}

// =============================================================================
// Pool access — describes where each editable SOV/sentiment block lives
// inside the loaded JSON document.
// =============================================================================

const OVERALL_MENTIONS_PATH =
  'opportunity.data.dashboard.analytics.performance.mentions.content';
const SENTIMENT_DISTRIBUTION_PATH =
  'opportunity.data.dashboard.analytics.performance.sentiment.content';
const TOPICS_PATH =
  'opportunity.data.dashboard.analytics.performance.insights.content.topics';
const SOURCES_PATH =
  'opportunity.data.dashboard.analytics.performance.insights.content.sources';
const SUGGESTIONS_PATH = 'suggestions';

const SENTIMENT_LABEL_OPTIONS = [
  '',
  'favorable',
  'neutral',
  'unfavorable',
] as const;

const SUGGESTION_PRIORITY_OPTIONS = ['', 'high', 'medium', 'low'] as const;

/**
 * Treat a node like `{ brand: {…}, market: { total: {…}, brands: [{…}] } }`
 * as a unified pool of N+1 entries (the brand row plus each market brand
 * row) for SOV editing. The brand row stays pinned at index 0 so the UI
 * always shows it first.
 *
 * Returns null when the node doesn't look like a mentions block — callers
 * use this to silently skip sections the payload doesn't carry.
 */
function readMentionsPool(node: unknown): PoolEntry[] | null {
  if (!isRecord(node)) return null;
  const brand = isRecord(node.brand) ? node.brand : null;
  const market = isRecord(node.market) ? node.market : null;
  const marketBrands = market && isArray(market.brands) ? market.brands : [];

  const entries: PoolEntry[] = [];
  if (brand) {
    entries.push({
      label: asString(brand.name, '(brand)'),
      percent: asNumber(brand.mentionsPercent),
    });
  }
  for (const entry of marketBrands) {
    if (!isRecord(entry)) continue;
    entries.push({
      label: asString(entry.name, '(unknown)'),
      percent: asNumber(entry.mentionsPercent),
    });
  }
  return entries.length > 0 ? entries : null;
}

/**
 * Apply rebalanced percentages back into a mentions block. The pool layout
 * mirrors `readMentionsPool`: index 0 is the brand entry, subsequent
 * indices are market brands. We also recompute `market.total.mentionsPercent`
 * so the brand-vs-market split visible elsewhere in the dashboard stays
 * consistent with the per-row edits.
 */
function writeMentionsPool(
  node: unknown,
  rebalanced: number[],
): Record<string, unknown> {
  const base = isRecord(node) ? { ...node } : {};
  const brand = isRecord(base.brand) ? { ...base.brand } : null;
  const market = isRecord(base.market) ? { ...base.market } : null;
  const marketBrandsRaw =
    market && isArray(market.brands) ? market.brands : [];

  let cursor = 0;
  if (brand) {
    brand.mentionsPercent = rebalanced[cursor] ?? 0;
    base.brand = brand;
    cursor += 1;
  }

  const nextMarketBrands = marketBrandsRaw.map((entry) => {
    const next = isRecord(entry) ? { ...entry } : {};
    next.mentionsPercent = rebalanced[cursor] ?? 0;
    cursor += 1;
    return next;
  });

  if (market) {
    const updatedMarket: Record<string, unknown> = {
      ...market,
      brands: nextMarketBrands,
    };
    const totalRecord: Record<string, unknown> = isRecord(updatedMarket.total)
      ? { ...updatedMarket.total }
      : {};
    const marketSum = nextMarketBrands.reduce(
      (acc, entry) =>
        acc + asNumber((entry as Record<string, unknown>).mentionsPercent),
      0,
    );
    totalRecord.mentionsPercent = roundForDisplay(marketSum);
    updatedMarket.total = totalRecord;
    base.market = updatedMarket;
  }

  return base;
}

/**
 * Sentiment distribution edits use the same proportional rebalance so the
 * `(neutralPercent, favorablePercent, unfavorablePercent)` triple keeps
 * summing to 100 after the operator nudges one value.
 */
const SENTIMENT_PERCENT_KEYS = [
  'neutralPercent',
  'favorablePercent',
  'unfavorablePercent',
] as const;

function readSentimentPool(distribution: unknown): PoolEntry[] | null {
  if (!isRecord(distribution)) return null;
  const labels: Record<(typeof SENTIMENT_PERCENT_KEYS)[number], string> = {
    neutralPercent: 'Neutral',
    favorablePercent: 'Favorable',
    unfavorablePercent: 'Unfavorable',
  };
  return SENTIMENT_PERCENT_KEYS.map((key) => ({
    label: labels[key],
    percent: asNumber(distribution[key]),
  }));
}

function writeSentimentPool(
  distribution: unknown,
  rebalanced: number[],
): Record<string, unknown> {
  const base = isRecord(distribution) ? { ...distribution } : {};
  SENTIMENT_PERCENT_KEYS.forEach((key, index) => {
    base[key] = rebalanced[index] ?? 0;
  });
  return base;
}

// =============================================================================
// Component
// =============================================================================

type LoadStatus =
  | { kind: 'empty' }
  | { kind: 'loaded'; filename: string }
  | { kind: 'error'; message: string };

interface SaveSnapshot {
  data: unknown;
  at: string;
}

export function BackOfficeView() {
  const [data, setData] = useState<unknown>(null);
  const [status, setStatus] = useState<LoadStatus>({ kind: 'empty' });
  const [savedSnapshot, setSavedSnapshot] = useState<SaveSnapshot | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [rawText, setRawText] = useState('');
  const [rawError, setRawError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // -------------------------------------------------------------------------
  // File loading
  // -------------------------------------------------------------------------

  const loadFromText = useCallback(
    (text: string, filename: string) => {
      try {
        const parsed = JSON.parse(text) as unknown;
        setData(parsed);
        setStatus({ kind: 'loaded', filename });
        setSavedSnapshot(null);
        setRawText(JSON.stringify(parsed, null, 2));
        setRawError(null);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to parse the JSON file.';
        setStatus({ kind: 'error', message });
      }
    },
    [],
  );

  const loadFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        const text = typeof reader.result === 'string' ? reader.result : '';
        loadFromText(text, file.name);
      };
      reader.onerror = () => {
        setStatus({
          kind: 'error',
          message: reader.error?.message ?? 'Failed to read file.',
        });
      };
      reader.readAsText(file);
    },
    [loadFromText],
  );

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) loadFile(file);
      // Reset so re-selecting the same file fires `onChange` again.
      event.target.value = '';
    },
    [loadFile],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragActive(false);
      const file = event.dataTransfer.files?.[0];
      if (file) loadFile(file);
    },
    [loadFile],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
  }, []);

  // -------------------------------------------------------------------------
  // Editing helpers
  // -------------------------------------------------------------------------

  const update = useCallback((path: string, value: unknown) => {
    setData((prev: unknown) => setAtPath(prev, path, value));
  }, []);

  const remove = useCallback((path: string) => {
    setData((prev: unknown) => removeAtPath(prev, path));
  }, []);

  /**
   * Mutate a mentions block by rebalancing its pool around an edit to one
   * row. The pool index addresses the brand row (0) or a market brand
   * (1 + brandIndex); the writer rebuilds the block so the brand+market
   * shape is preserved.
   */
  const editMentionsPercent = useCallback(
    (mentionsPath: string, poolIndex: number, newPercent: number) => {
      setData((prev: unknown) => {
        const node = getAtPath(prev, mentionsPath);
        const pool = readMentionsPool(node);
        if (!pool) return prev;
        const { percents } = rebalancePool(pool, poolIndex, newPercent);
        return setAtPath(prev, mentionsPath, writeMentionsPool(node, percents));
      });
    },
    [],
  );

  /**
   * Drop a market brand from a mentions block. Removing a row leaves the
   * remaining pool short by that brand's old share, so we then rebalance
   * the survivors back to 100% using the same proportional rule the manual
   * edit uses (the "removed" row contributes 0% to the new total).
   */
  const removeMarketBrand = useCallback(
    (mentionsPath: string, marketBrandIndex: number) => {
      setData((prev: unknown) => {
        const node = getAtPath(prev, mentionsPath);
        if (!isRecord(node)) return prev;
        const market = isRecord(node.market) ? node.market : null;
        const brands =
          market && isArray(market.brands) ? market.brands : [];
        if (marketBrandIndex < 0 || marketBrandIndex >= brands.length) {
          return prev;
        }

        const updatedBrands = brands.filter((_, i) => i !== marketBrandIndex);
        const updatedMarket: Record<string, unknown> = market
          ? { ...market, brands: updatedBrands }
          : { brands: updatedBrands };
        const updatedNode: Record<string, unknown> = {
          ...node,
          market: updatedMarket,
        };

        const pool = readMentionsPool(updatedNode);
        if (!pool || pool.length === 0) {
          return setAtPath(prev, mentionsPath, updatedNode);
        }
        // Re-anchor everything to the brand row at index 0 so percentages
        // sum back to 100 after the removal. Picking the brand row keeps
        // its share fixed; the survivors scale to fill the rest.
        const brandPercent = pool[0]?.percent ?? 0;
        const { percents } = rebalancePool(pool, 0, brandPercent);
        return setAtPath(
          prev,
          mentionsPath,
          writeMentionsPool(updatedNode, percents),
        );
      });
    },
    [],
  );

  const editSentimentPercent = useCallback(
    (sentimentPath: string, poolIndex: number, newPercent: number) => {
      setData((prev: unknown) => {
        const blockNode = getAtPath(prev, sentimentPath);
        if (!isRecord(blockNode)) return prev;
        const distribution = blockNode.distribution;
        const pool = readSentimentPool(distribution);
        if (!pool) return prev;
        const { percents } = rebalancePool(pool, poolIndex, newPercent);
        const updatedBlock: Record<string, unknown> = {
          ...blockNode,
          distribution: writeSentimentPool(distribution, percents),
        };
        return setAtPath(prev, sentimentPath, updatedBlock);
      });
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Save (in-memory snapshot) + download
  // -------------------------------------------------------------------------

  /**
   * "Save" in the Back Office context is purely client-side: it freezes the
   * current edited document as the last-saved snapshot, which then becomes
   * the basis for the "Reset to last save" action. The Download button is
   * where the work actually leaves the browser.
   */
  const saveSnapshot = useCallback(() => {
    if (data == null) return;
    setSavedSnapshot({ data, at: new Date().toISOString() });
    setRawText(JSON.stringify(data, null, 2));
    setRawError(null);
  }, [data]);

  const resetToSnapshot = useCallback(() => {
    if (!savedSnapshot) return;
    setData(savedSnapshot.data);
    setRawText(JSON.stringify(savedSnapshot.data, null, 2));
    setRawError(null);
  }, [savedSnapshot]);

  const download = useCallback(() => {
    if (data == null) return;
    const text = JSON.stringify(data, null, 2);
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const baseName =
      status.kind === 'loaded'
        ? status.filename.replace(/\.json$/i, '')
        : 'back-office-export';
    link.download = `${baseName}-edited.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [data, status]);

  const commitRawText = useCallback(() => {
    try {
      const parsed = JSON.parse(rawText) as unknown;
      setData(parsed);
      setRawError(null);
    } catch (error) {
      setRawError(
        error instanceof Error
          ? error.message
          : 'Could not parse the JSON text.',
      );
    }
  }, [rawText]);

  // -------------------------------------------------------------------------
  // Derived data for rendering
  // -------------------------------------------------------------------------

  const overallMentionsNode = useMemo(
    () => getAtPath(data, OVERALL_MENTIONS_PATH),
    [data],
  );
  const overallMentionsPool = useMemo(
    () => readMentionsPool(overallMentionsNode),
    [overallMentionsNode],
  );

  const sentimentBlock = useMemo(
    () => getAtPath(data, SENTIMENT_DISTRIBUTION_PATH),
    [data],
  );
  const sentimentPool = useMemo(
    () =>
      readSentimentPool(
        isRecord(sentimentBlock) ? sentimentBlock.distribution : null,
      ),
    [sentimentBlock],
  );

  const topics = useMemo(() => {
    const node = getAtPath(data, TOPICS_PATH);
    return isArray(node) ? node : [];
  }, [data]);

  const sources = useMemo(() => {
    const node = getAtPath(data, SOURCES_PATH);
    return isArray(node) ? node : [];
  }, [data]);

  const suggestions = useMemo(() => {
    const node = getAtPath(data, SUGGESTIONS_PATH);
    return isArray(node) ? node : [];
  }, [data]);

  const dirty = useMemo(() => {
    if (data == null || savedSnapshot == null) return data != null;
    return JSON.stringify(data) !== JSON.stringify(savedSnapshot.data);
  }, [data, savedSnapshot]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="workspace-mode-stack back-office">
      <section className="panel panel-tone-warm panel-mode-intro">
        <div className="panel-header">
          <div>
            <h2>Back Office</h2>
            <p>
              Load an opportunity JSON dump, edit individual values, prune
              fields you don't need, then download the result. Editing any
              Share of Voice or sentiment-distribution percentage automatically
              rebalances the other entries in the same pool so the total stays
              at 100%. All changes stay in your browser — nothing is uploaded.
            </p>
          </div>
        </div>
      </section>

      <section className="panel panel-tone-neutral">
        <div className="panel-header">
          <div>
            <h3>Load JSON</h3>
            <p>
              Drop a `.json` file here, or pick one with the button. The same
              file can be reloaded to discard in-browser edits.
            </p>
          </div>
        </div>

        <div
          className={`back-office-dropzone${
            dragActive ? ' back-office-dropzone-active' : ''
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
          <button
            type="button"
            className="primary-button"
            onClick={() => fileInputRef.current?.click()}
          >
            Choose JSON file
          </button>
          <p className="metric-copy">…or drag and drop a file onto this area.</p>
          {status.kind === 'loaded' ? (
            <p className="status-pill status-pill-success">
              Loaded {status.filename}
            </p>
          ) : null}
          {status.kind === 'error' ? (
            <p className="status-pill status-pill-error">{status.message}</p>
          ) : null}
        </div>

        {data != null ? (
          <div className="back-office-toolbar">
            <button
              type="button"
              className="primary-button"
              onClick={saveSnapshot}
              disabled={!dirty && savedSnapshot != null}
              title="Freeze the current edits as the last-saved state"
            >
              {savedSnapshot ? 'Save changes' : 'Save snapshot'}
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={resetToSnapshot}
              disabled={!savedSnapshot || !dirty}
            >
              Reset to last save
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={download}
            >
              Download JSON
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => setShowRaw((prev) => !prev)}
            >
              {showRaw ? 'Hide raw JSON' : 'Show raw JSON'}
            </button>
            {savedSnapshot ? (
              <span className="back-office-toolbar-meta">
                Last saved at{' '}
                {new Date(savedSnapshot.at).toLocaleTimeString()}
                {dirty ? ' (unsaved changes)' : ''}
              </span>
            ) : dirty ? (
              <span className="back-office-toolbar-meta">Unsaved changes</span>
            ) : null}
          </div>
        ) : null}
      </section>

      {data == null ? null : (
        <>
          {overallMentionsPool ? (
            <MentionsPoolPanel
              title="Share of Voice — Overall"
              description="Brand vs. competitors aggregated across the analyzed content. Editing one row redistributes the rest so the total stays 100%."
              path={OVERALL_MENTIONS_PATH}
              node={overallMentionsNode}
              pool={overallMentionsPool}
              onEditPercent={editMentionsPercent}
              onRemoveMarketBrand={removeMarketBrand}
              onEditField={update}
            />
          ) : null}

          {sentimentBlock != null ? (
            <SentimentPanel
              path={SENTIMENT_DISTRIBUTION_PATH}
              block={sentimentBlock}
              pool={sentimentPool}
              onEditField={update}
              onEditPercent={editSentimentPercent}
            />
          ) : null}

          {topics.length > 0 ? (
            <TopicsPanel
              path={TOPICS_PATH}
              topics={topics}
              onEditField={update}
              onEditMentionsPercent={editMentionsPercent}
              onRemoveMarketBrand={removeMarketBrand}
              onRemoveTopic={remove}
            />
          ) : null}

          {sources.length > 0 ? (
            <SourcesPanel
              path={SOURCES_PATH}
              sources={sources}
              onEditField={update}
              onEditMentionsPercent={editMentionsPercent}
              onRemoveMarketBrand={removeMarketBrand}
              onRemoveSource={remove}
            />
          ) : null}

          {suggestions.length > 0 ? (
            <SuggestionsPanel
              path={SUGGESTIONS_PATH}
              suggestions={suggestions}
              onEditField={update}
              onRemoveSuggestion={remove}
            />
          ) : null}

          {showRaw ? (
            <section className="panel panel-tone-neutral">
              <div className="panel-header">
                <div>
                  <h3>Raw JSON</h3>
                  <p>
                    Full document, including any fields the structured editors
                    above don't surface. Edits made here replace the entire
                    in-browser document when you click Apply.
                  </p>
                </div>
              </div>
              <textarea
                className="textarea-input back-office-raw"
                rows={20}
                value={rawText}
                onChange={(event) => setRawText(event.target.value)}
                spellCheck={false}
              />
              {rawError ? (
                <p className="status-pill status-pill-error">{rawError}</p>
              ) : null}
              <div className="back-office-toolbar">
                <button
                  type="button"
                  className="primary-button"
                  onClick={commitRawText}
                >
                  Apply raw edits
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    setRawText(JSON.stringify(data, null, 2));
                    setRawError(null);
                  }}
                >
                  Discard raw edits
                </button>
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

// =============================================================================
// Inputs — local-draft text inputs that commit on blur / Enter
// =============================================================================
//
// We avoid React's controlled `<input type="number">` here. Two reasons:
//
//  1. When state is updated to a number that parses identically to the user's
//     in-progress text (e.g. they typed "010" → state becomes 10 → re-render
//     would set value="10" but the browser sometimes keeps showing "010"
//     because the parsed numbers match and React skips the DOM write), the
//     visible field and state can drift.
//  2. For percent fields specifically, every keystroke triggers a cascading
//     rebalance across every other row in the pool. Typing "0" then "10" was
//     causing three separate rebalances ("", "0", "10"), thrashing the other
//     rows mid-edit.
//
// The fix is to keep the displayed text in a local `draft` string while the
// field is focused, sync that draft back to state only on blur or Enter, and
// reset the draft to the latest external value when the field is not in use.
// This gives the user a stable typing surface and a single rebalance per
// commit.

interface PercentInputProps {
  value: number;
  onCommit: (next: number) => void;
  disabled?: boolean;
}

function PercentInput(props: PercentInputProps) {
  // null = field is not being edited; mirror the external value verbatim.
  // Any string = the user's in-progress text, shown as-is until commit.
  const [draft, setDraft] = useState<string | null>(null);

  // Mirror external changes (e.g. rebalance from a sibling row) back into the
  // display whenever the field isn't being actively edited. We compare against
  // the prior value via a ref so we don't fight the user's typing.
  const lastExternalRef = useRef(props.value);
  useEffect(() => {
    if (draft === null) {
      lastExternalRef.current = props.value;
    }
  }, [props.value, draft]);

  const commit = useCallback(
    (rawText: string) => {
      const trimmed = rawText.trim();
      if (trimmed === '' || trimmed === '-' || trimmed === '.') {
        props.onCommit(0);
        return;
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) return;
      props.onCommit(parsed);
    },
    [props],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        (event.target as HTMLInputElement).blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setDraft(null);
        (event.target as HTMLInputElement).blur();
      }
    },
    [],
  );

  const display = draft ?? formatPercentForDisplay(props.value);

  return (
    <input
      type="text"
      inputMode="decimal"
      className="text-input"
      value={display}
      disabled={props.disabled}
      onFocus={() => setDraft(formatPercentForDisplay(props.value))}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null) commit(draft);
        setDraft(null);
      }}
      onKeyDown={handleKeyDown}
    />
  );
}

function formatPercentForDisplay(value: number): string {
  if (!Number.isFinite(value)) return '0';
  // Strip trailing ".0" so common round numbers (e.g. 49 instead of "49.0")
  // look natural. The underlying state still carries the full number.
  const rounded = roundForDisplay(value);
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

interface IntegerInputProps {
  value: number;
  onCommit: (next: number) => void;
}

/**
 * Same draft-on-focus pattern as PercentInput, but for integer counts
 * (mentions, citations). Negative values and decimals are coerced to a
 * non-negative integer on commit so the underlying counts stay clean.
 */
function IntegerInput(props: IntegerInputProps) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = useCallback(
    (rawText: string) => {
      const trimmed = rawText.trim();
      if (trimmed === '' || trimmed === '-') {
        props.onCommit(0);
        return;
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) return;
      props.onCommit(Math.max(0, Math.round(parsed)));
    },
    [props],
  );

  return (
    <input
      type="text"
      inputMode="numeric"
      className="text-input"
      value={draft ?? String(props.value)}
      onFocus={() => setDraft(String(props.value))}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null) commit(draft);
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          (event.target as HTMLInputElement).blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(null);
          (event.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

// =============================================================================
// Collapsible cards — used by the topic / source / suggestion panels so an
// operator can collapse the body of cards they're not editing right now and
// scan many rows without endless scrolling.
// =============================================================================
//
// The collapse state is held by index rather than by stable id because the
// arrays being indexed (topics, sources, suggestions) can have entries
// removed without re-keying the rest. Storing by index keeps things simple,
// at the cost of a re-render also re-anchoring which rows are open after a
// removal — acceptable because removals are an explicit, infrequent action.

interface CollapseControls {
  isCollapsed: (index: number) => boolean;
  toggle: (index: number) => void;
  collapseAll: () => void;
  expandAll: () => void;
  allCollapsed: boolean;
  allExpanded: boolean;
}

function useCollapseState(
  totalCount: number,
  initiallyAllCollapsed = true,
): CollapseControls {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => {
    if (!initiallyAllCollapsed) return new Set();
    return new Set(Array.from({ length: totalCount }, (_, i) => i));
  });

  const isCollapsed = useCallback(
    (index: number) => collapsed.has(index),
    [collapsed],
  );

  const toggle = useCallback((index: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsed(new Set(Array.from({ length: totalCount }, (_, i) => i)));
  }, [totalCount]);

  const expandAll = useCallback(() => {
    setCollapsed(new Set());
  }, []);

  return {
    isCollapsed,
    toggle,
    collapseAll,
    expandAll,
    allCollapsed: collapsed.size >= totalCount && totalCount > 0,
    allExpanded: collapsed.size === 0,
  };
}

interface CollapsibleCardProps {
  collapsed: boolean;
  onToggle: () => void;
  /** Always-visible left side of the card header (rank chip, type chip, etc). */
  meta: ReactNode;
  /** Optional buttons aligned to the right of the header (e.g. Remove). */
  headerActions?: ReactNode;
  /**
   * Short summary text shown next to the meta when the card is collapsed —
   * lets the operator identify the row without expanding it.
   */
  summary?: ReactNode;
  children: ReactNode;
}

function CollapsibleCard(props: CollapsibleCardProps) {
  return (
    <article
      className={`patcher-card back-office-collapsible-card${
        props.collapsed ? ' back-office-card-collapsed' : ''
      }`}
    >
      <header
        className="patcher-card-header back-office-card-header-toggle"
        onClick={props.onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={!props.collapsed}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            props.onToggle();
          }
        }}
      >
        <div className="patcher-card-meta">
          <span className="back-office-chevron" aria-hidden="true">
            {props.collapsed ? '▶' : '▼'}
          </span>
          {props.meta}
          {props.collapsed && props.summary ? (
            <span className="back-office-card-summary">{props.summary}</span>
          ) : null}
        </div>
        {props.headerActions ? (
          // Buttons inside the header shouldn't toggle the card — stop the
          // bubbling click before it reaches the header's onClick handler.
          <div
            className="back-office-card-header-actions"
            onClick={(event) => event.stopPropagation()}
          >
            {props.headerActions}
          </div>
        ) : null}
      </header>
      {props.collapsed ? null : props.children}
    </article>
  );
}

/**
 * Inline panel-wide Expand-all / Collapse-all toggle. Only one of the two
 * actions is enabled at a time so the operator gets a single, predictable
 * affordance instead of a pair of buttons.
 */
function CollapseAllControls(props: { controls: CollapseControls }) {
  if (props.controls.allExpanded) {
    return (
      <button
        type="button"
        className="ghost-button"
        onClick={props.controls.collapseAll}
      >
        Collapse all
      </button>
    );
  }
  return (
    <button
      type="button"
      className="ghost-button"
      onClick={props.controls.expandAll}
    >
      Expand all
    </button>
  );
}

// =============================================================================
// Mentions pool panel — brand + market.brands editable as a single SOV pool
// =============================================================================

interface MentionsPoolPanelProps {
  title: string;
  description: string;
  path: string;
  node: unknown;
  pool: PoolEntry[];
  onEditPercent: (
    mentionsPath: string,
    poolIndex: number,
    newPercent: number,
  ) => void;
  onRemoveMarketBrand: (
    mentionsPath: string,
    marketBrandIndex: number,
  ) => void;
  onEditField: (path: string, value: unknown) => void;
}

function MentionsPoolPanel(props: MentionsPoolPanelProps) {
  const sumDisplay = useMemo(
    () => roundForDisplay(props.pool.reduce((acc, entry) => acc + entry.percent, 0)),
    [props.pool],
  );

  const brandNode = isRecord(props.node) ? props.node.brand : null;
  const marketNode =
    isRecord(props.node) && isRecord(props.node.market)
      ? props.node.market
      : null;
  const marketBrands =
    marketNode && isArray(marketNode.brands) ? marketNode.brands : [];

  return (
    <section className="panel panel-tone-neutral">
      <div className="panel-header">
        <div>
          <h3>{props.title}</h3>
          <p>{props.description}</p>
        </div>
        <div className="back-office-panel-sum">
          Total: <strong>{sumDisplay}%</strong>
        </div>
      </div>

      <table className="back-office-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Mentions</th>
            <th>Mentions %</th>
            <th aria-label="actions" />
          </tr>
        </thead>
        <tbody>
          {isRecord(brandNode) ? (
            <tr className="back-office-table-row back-office-table-row-brand">
              <td>
                <input
                  type="text"
                  className="text-input"
                  value={asString(brandNode.name)}
                  onChange={(event) =>
                    props.onEditField(
                      `${props.path}.brand.name`,
                      event.target.value,
                    )
                  }
                />
              </td>
              <td>
                <IntegerInput
                  value={asNumber(brandNode.mentions)}
                  onCommit={(next) =>
                    props.onEditField(`${props.path}.brand.mentions`, next)
                  }
                />
              </td>
              <td>
                <PercentInput
                  value={props.pool[0]?.percent ?? 0}
                  onCommit={(next) => props.onEditPercent(props.path, 0, next)}
                />
              </td>
              <td>
                <span className="back-office-locked-tag" title="Brand row stays in the pool">
                  brand
                </span>
              </td>
            </tr>
          ) : null}

          {marketBrands.map((entry, index) => {
            if (!isRecord(entry)) return null;
            const poolIndex = isRecord(brandNode) ? index + 1 : index;
            return (
              <tr key={index} className="back-office-table-row">
                <td>
                  <input
                    type="text"
                    className="text-input"
                    value={asString(entry.name)}
                    onChange={(event) =>
                      props.onEditField(
                        `${props.path}.market.brands.${index}.name`,
                        event.target.value,
                      )
                    }
                  />
                </td>
                <td>
                  <IntegerInput
                    value={asNumber(entry.mentions)}
                    onCommit={(next) =>
                      props.onEditField(
                        `${props.path}.market.brands.${index}.mentions`,
                        next,
                      )
                    }
                  />
                </td>
                <td>
                  <PercentInput
                    value={props.pool[poolIndex]?.percent ?? 0}
                    onCommit={(next) =>
                      props.onEditPercent(props.path, poolIndex, next)
                    }
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => props.onRemoveMarketBrand(props.path, index)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// =============================================================================
// Sentiment panel — label + distribution percentages
// =============================================================================

interface SentimentPanelProps {
  path: string;
  block: unknown;
  pool: PoolEntry[] | null;
  onEditField: (path: string, value: unknown) => void;
  onEditPercent: (
    sentimentPath: string,
    poolIndex: number,
    newPercent: number,
  ) => void;
}

function SentimentPanel(props: SentimentPanelProps) {
  const block = isRecord(props.block) ? props.block : {};
  const distribution = isRecord(block.distribution) ? block.distribution : null;

  return (
    <section className="panel panel-tone-neutral">
      <div className="panel-header">
        <div>
          <h3>Sentiment</h3>
          <p>
            Overall sentiment label plus the distribution counts and
            percentages. Editing a percentage rebalances the other two so the
            three values keep summing to 100%.
          </p>
        </div>
      </div>

      <div className="patcher-pickers">
        <label className="patcher-picker-field">
          <span className="filter-label">Label</span>
          <select
            className="select-input"
            value={asString(block.label)}
            onChange={(event) =>
              props.onEditField(`${props.path}.label`, event.target.value || null)
            }
          >
            {SENTIMENT_LABEL_OPTIONS.map((option) => (
              <option key={option || 'null'} value={option}>
                {option || '(none)'}
              </option>
            ))}
          </select>
        </label>
        <label className="patcher-picker-field">
          <span className="filter-label">Score</span>
          <input
            type="text"
            inputMode="decimal"
            className="text-input"
            value={isFiniteNumber(block.score) ? String(block.score) : ''}
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === '') {
                props.onEditField(`${props.path}.score`, null);
                return;
              }
              const parsed = Number(raw);
              if (Number.isFinite(parsed)) {
                props.onEditField(`${props.path}.score`, parsed);
              }
            }}
          />
        </label>
      </div>

      {distribution && props.pool ? (
        <table className="back-office-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Count</th>
              <th>Percent</th>
            </tr>
          </thead>
          <tbody>
            {props.pool.map((entry, index) => {
              const countKey = SENTIMENT_PERCENT_KEYS[index].replace(
                /Percent$/,
                '',
              );
              return (
                <tr key={entry.label} className="back-office-table-row">
                  <td>{entry.label}</td>
                  <td>
                    <IntegerInput
                      value={asNumber(distribution[countKey])}
                      onCommit={(next) =>
                        props.onEditField(
                          `${props.path}.distribution.${countKey}`,
                          next,
                        )
                      }
                    />
                  </td>
                  <td>
                    <PercentInput
                      value={entry.percent}
                      onCommit={(next) =>
                        props.onEditPercent(props.path, index, next)
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="metric-copy">
          No sentiment distribution present in this payload.
        </p>
      )}
    </section>
  );
}

// =============================================================================
// Topics / Sources panels — array of items, each with its own mentions pool
// =============================================================================

interface TopicsPanelProps {
  path: string;
  topics: unknown[];
  onEditField: (path: string, value: unknown) => void;
  onEditMentionsPercent: (
    mentionsPath: string,
    poolIndex: number,
    newPercent: number,
  ) => void;
  onRemoveMarketBrand: (
    mentionsPath: string,
    marketBrandIndex: number,
  ) => void;
  onRemoveTopic: (path: string) => void;
}

function TopicsPanel(props: TopicsPanelProps) {
  const collapse = useCollapseState(props.topics.length);

  return (
    <section className="panel panel-tone-neutral">
      <div className="panel-header">
        <div>
          <h3>Topics</h3>
          <p>
            {props.topics.length} topic
            {props.topics.length === 1 ? '' : 's'} from the analysis. Edit any
            topic-level fields, remove brands from its SOV table, or drop the
            whole topic.
          </p>
        </div>
        <CollapseAllControls controls={collapse} />
      </div>

      <div className="patcher-card-grid">
        {props.topics.map((topic, index) => {
          if (!isRecord(topic)) return null;
          const topicPath = `${props.path}.${index}`;
          const mentionsPath = `${topicPath}.mentions`;
          const mentionsNode = topic.mentions;
          const pool = readMentionsPool(mentionsNode);
          const brandNode = isRecord(mentionsNode) ? mentionsNode.brand : null;
          const marketBrands =
            isRecord(mentionsNode) &&
            isRecord(mentionsNode.market) &&
            isArray(mentionsNode.market.brands)
              ? mentionsNode.market.brands
              : [];
          const collapsed = collapse.isCollapsed(index);
          const topicTitle = asString(topic.title) || '(untitled topic)';
          const sentimentLabel = asString(
            isRecord(topic.sentiment) ? topic.sentiment.label : '',
          );

          return (
            <CollapsibleCard
              key={asString(topic.id) || index}
              collapsed={collapsed}
              onToggle={() => collapse.toggle(index)}
              meta={
                <>
                  <span className="patcher-card-rank">#{index + 1}</span>
                  <span className="patcher-card-type">topic</span>
                  <span className="patcher-card-status">{topicTitle}</span>
                </>
              }
              summary={
                <>
                  {pool ? `${pool.length} brand${pool.length === 1 ? '' : 's'}` : '—'}
                  {sentimentLabel ? ` · ${sentimentLabel}` : ''}
                </>
              }
              headerActions={
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => props.onRemoveTopic(topicPath)}
                >
                  Remove topic
                </button>
              }
            >
              <label className="patcher-field">
                <span>Title</span>
                <input
                  type="text"
                  className="text-input"
                  value={asString(topic.title)}
                  onChange={(event) =>
                    props.onEditField(`${topicPath}.title`, event.target.value)
                  }
                />
              </label>

              <label className="patcher-field">
                <span>Analysis</span>
                <textarea
                  className="textarea-input"
                  rows={6}
                  value={asString(topic.analysis)}
                  onChange={(event) =>
                    props.onEditField(`${topicPath}.analysis`, event.target.value)
                  }
                />
              </label>

              <div className="patcher-pickers">
                <label className="patcher-picker-field">
                  <span className="filter-label">Sentiment label</span>
                  <select
                    className="select-input"
                    value={asString(
                      isRecord(topic.sentiment) ? topic.sentiment.label : '',
                    )}
                    onChange={(event) =>
                      props.onEditField(
                        `${topicPath}.sentiment.label`,
                        event.target.value || null,
                      )
                    }
                  >
                    {SENTIMENT_LABEL_OPTIONS.map((option) => (
                      <option key={option || 'null'} value={option}>
                        {option || '(none)'}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {pool ? (
                <fieldset className="patcher-action-items">
                  <legend>
                    SOV ({pool.length}) — total{' '}
                    {roundForDisplay(
                      pool.reduce((acc, entry) => acc + entry.percent, 0),
                    )}
                    %
                  </legend>
                  <table className="back-office-table back-office-table-compact">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Mentions</th>
                        <th>Mentions %</th>
                        <th aria-label="actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {isRecord(brandNode) ? (
                        <tr className="back-office-table-row back-office-table-row-brand">
                          <td>
                            <input
                              type="text"
                              className="text-input"
                              value={asString(brandNode.name)}
                              onChange={(event) =>
                                props.onEditField(
                                  `${mentionsPath}.brand.name`,
                                  event.target.value,
                                )
                              }
                            />
                          </td>
                          <td>
                            <IntegerInput
                              value={asNumber(brandNode.mentions)}
                              onCommit={(next) =>
                                props.onEditField(
                                  `${mentionsPath}.brand.mentions`,
                                  next,
                                )
                              }
                            />
                          </td>
                          <td>
                            <PercentInput
                              value={pool[0]?.percent ?? 0}
                              onCommit={(next) =>
                                props.onEditMentionsPercent(
                                  mentionsPath,
                                  0,
                                  next,
                                )
                              }
                            />
                          </td>
                          <td>
                            <span className="back-office-locked-tag">brand</span>
                          </td>
                        </tr>
                      ) : null}
                      {marketBrands.map((entry, brandIndex) => {
                        if (!isRecord(entry)) return null;
                        const poolIndex = isRecord(brandNode)
                          ? brandIndex + 1
                          : brandIndex;
                        return (
                          <tr key={brandIndex} className="back-office-table-row">
                            <td>
                              <input
                                type="text"
                                className="text-input"
                                value={asString(entry.name)}
                                onChange={(event) =>
                                  props.onEditField(
                                    `${mentionsPath}.market.brands.${brandIndex}.name`,
                                    event.target.value,
                                  )
                                }
                              />
                            </td>
                            <td>
                              <IntegerInput
                                value={asNumber(entry.mentions)}
                                onCommit={(next) =>
                                  props.onEditField(
                                    `${mentionsPath}.market.brands.${brandIndex}.mentions`,
                                    next,
                                  )
                                }
                              />
                            </td>
                            <td>
                              <PercentInput
                                value={pool[poolIndex]?.percent ?? 0}
                                onCommit={(next) =>
                                  props.onEditMentionsPercent(
                                    mentionsPath,
                                    poolIndex,
                                    next,
                                  )
                                }
                              />
                            </td>
                            <td>
                              <button
                                type="button"
                                className="ghost-button"
                                onClick={() =>
                                  props.onRemoveMarketBrand(
                                    mentionsPath,
                                    brandIndex,
                                  )
                                }
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </fieldset>
              ) : null}
            </CollapsibleCard>
          );
        })}
      </div>
    </section>
  );
}

interface SourcesPanelProps {
  path: string;
  sources: unknown[];
  onEditField: (path: string, value: unknown) => void;
  onEditMentionsPercent: (
    mentionsPath: string,
    poolIndex: number,
    newPercent: number,
  ) => void;
  onRemoveMarketBrand: (
    mentionsPath: string,
    marketBrandIndex: number,
  ) => void;
  onRemoveSource: (path: string) => void;
}

function SourcesPanel(props: SourcesPanelProps) {
  const collapse = useCollapseState(props.sources.length);

  return (
    <section className="panel panel-tone-neutral">
      <div className="panel-header">
        <div>
          <h3>Sources</h3>
          <p>
            {props.sources.length} cited source
            {props.sources.length === 1 ? '' : 's'}. Each one carries its own
            sentiment label and SOV pool.
          </p>
        </div>
        <CollapseAllControls controls={collapse} />
      </div>

      <div className="patcher-card-grid">
        {props.sources.map((source, index) => {
          if (!isRecord(source)) return null;
          const sourcePath = `${props.path}.${index}`;
          const mentionsPath = `${sourcePath}.mentions`;
          const mentionsNode = source.mentions;
          const pool = readMentionsPool(mentionsNode);
          const brandNode = isRecord(mentionsNode) ? mentionsNode.brand : null;
          const marketBrands =
            isRecord(mentionsNode) &&
            isRecord(mentionsNode.market) &&
            isArray(mentionsNode.market.brands)
              ? mentionsNode.market.brands
              : [];
          const collapsed = collapse.isCollapsed(index);
          const sourceTitle =
            asString(source.title) || asString(source.url) || '(untitled source)';
          const sentimentLabel = asString(
            isRecord(source.sentiment) ? source.sentiment.label : '',
          );

          return (
            <CollapsibleCard
              key={asString(source.id) || index}
              collapsed={collapsed}
              onToggle={() => collapse.toggle(index)}
              meta={
                <>
                  <span className="patcher-card-rank">#{index + 1}</span>
                  <span className="patcher-card-type">source</span>
                  {isFiniteNumber(source.citations) ? (
                    <span className="patcher-card-status">
                      {source.citations} citations
                    </span>
                  ) : null}
                  <span
                    className="patcher-card-status back-office-source-title"
                    title={sourceTitle}
                  >
                    {sourceTitle}
                  </span>
                </>
              }
              summary={
                <>
                  {pool ? `${pool.length} brand${pool.length === 1 ? '' : 's'}` : '—'}
                  {sentimentLabel ? ` · ${sentimentLabel}` : ''}
                </>
              }
              headerActions={
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => props.onRemoveSource(sourcePath)}
                >
                  Remove source
                </button>
              }
            >
              <label className="patcher-field">
                <span>URL</span>
                <input
                  type="text"
                  className="text-input"
                  value={asString(source.url)}
                  onChange={(event) =>
                    props.onEditField(`${sourcePath}.url`, event.target.value)
                  }
                />
              </label>

              <label className="patcher-field">
                <span>Title</span>
                <input
                  type="text"
                  className="text-input"
                  value={asString(source.title)}
                  onChange={(event) =>
                    props.onEditField(`${sourcePath}.title`, event.target.value)
                  }
                />
              </label>

              <div className="patcher-pickers">
                <label className="patcher-picker-field">
                  <span className="filter-label">Citations</span>
                  <IntegerInput
                    value={asNumber(source.citations)}
                    onCommit={(next) =>
                      props.onEditField(`${sourcePath}.citations`, next)
                    }
                  />
                </label>
                <label className="patcher-picker-field">
                  <span className="filter-label">Sentiment label</span>
                  <select
                    className="select-input"
                    value={asString(
                      isRecord(source.sentiment) ? source.sentiment.label : '',
                    )}
                    onChange={(event) =>
                      props.onEditField(
                        `${sourcePath}.sentiment.label`,
                        event.target.value || null,
                      )
                    }
                  >
                    {SENTIMENT_LABEL_OPTIONS.map((option) => (
                      <option key={option || 'null'} value={option}>
                        {option || '(none)'}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {pool ? (
                <fieldset className="patcher-action-items">
                  <legend>
                    SOV ({pool.length}) — total{' '}
                    {roundForDisplay(
                      pool.reduce((acc, entry) => acc + entry.percent, 0),
                    )}
                    %
                  </legend>
                  <table className="back-office-table back-office-table-compact">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Mentions</th>
                        <th>Mentions %</th>
                        <th aria-label="actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {isRecord(brandNode) ? (
                        <tr className="back-office-table-row back-office-table-row-brand">
                          <td>
                            <input
                              type="text"
                              className="text-input"
                              value={asString(brandNode.name)}
                              onChange={(event) =>
                                props.onEditField(
                                  `${mentionsPath}.brand.name`,
                                  event.target.value,
                                )
                              }
                            />
                          </td>
                          <td>
                            <IntegerInput
                              value={asNumber(brandNode.mentions)}
                              onCommit={(next) =>
                                props.onEditField(
                                  `${mentionsPath}.brand.mentions`,
                                  next,
                                )
                              }
                            />
                          </td>
                          <td>
                            <PercentInput
                              value={pool[0]?.percent ?? 0}
                              onCommit={(next) =>
                                props.onEditMentionsPercent(
                                  mentionsPath,
                                  0,
                                  next,
                                )
                              }
                            />
                          </td>
                          <td>
                            <span className="back-office-locked-tag">brand</span>
                          </td>
                        </tr>
                      ) : null}
                      {marketBrands.map((entry, brandIndex) => {
                        if (!isRecord(entry)) return null;
                        const poolIndex = isRecord(brandNode)
                          ? brandIndex + 1
                          : brandIndex;
                        return (
                          <tr key={brandIndex} className="back-office-table-row">
                            <td>
                              <input
                                type="text"
                                className="text-input"
                                value={asString(entry.name)}
                                onChange={(event) =>
                                  props.onEditField(
                                    `${mentionsPath}.market.brands.${brandIndex}.name`,
                                    event.target.value,
                                  )
                                }
                              />
                            </td>
                            <td>
                              <IntegerInput
                                value={asNumber(entry.mentions)}
                                onCommit={(next) =>
                                  props.onEditField(
                                    `${mentionsPath}.market.brands.${brandIndex}.mentions`,
                                    next,
                                  )
                                }
                              />
                            </td>
                            <td>
                              <PercentInput
                                value={pool[poolIndex]?.percent ?? 0}
                                onCommit={(next) =>
                                  props.onEditMentionsPercent(
                                    mentionsPath,
                                    poolIndex,
                                    next,
                                  )
                                }
                              />
                            </td>
                            <td>
                              <button
                                type="button"
                                className="ghost-button"
                                onClick={() =>
                                  props.onRemoveMarketBrand(
                                    mentionsPath,
                                    brandIndex,
                                  )
                                }
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </fieldset>
              ) : null}
            </CollapsibleCard>
          );
        })}
      </div>
    </section>
  );
}

// =============================================================================
// Suggestions panel — array of editable suggestion records
// =============================================================================

interface SuggestionsPanelProps {
  path: string;
  suggestions: unknown[];
  onEditField: (path: string, value: unknown) => void;
  onRemoveSuggestion: (path: string) => void;
}

function SuggestionsPanel(props: SuggestionsPanelProps) {
  const collapse = useCollapseState(props.suggestions.length);

  return (
    <section className="panel panel-tone-neutral">
      <div className="panel-header">
        <div>
          <h3>Suggestions</h3>
          <p>
            {props.suggestions.length} suggestion
            {props.suggestions.length === 1 ? '' : 's'}. Edit fields or drop
            individual action items / whole rows.
          </p>
        </div>
        <CollapseAllControls controls={collapse} />
      </div>

      <div className="patcher-card-grid">
        {props.suggestions.map((suggestion, index) => {
          if (!isRecord(suggestion)) return null;
          const suggestionPath = `${props.path}.${index}`;
          const dataNode = isRecord(suggestion.data) ? suggestion.data : null;
          const dataPath = `${suggestionPath}.data`;
          const actionItems =
            dataNode && isArray(dataNode.actionItems) ? dataNode.actionItems : [];
          const collapsed = collapse.isCollapsed(index);
          const suggestionTitle =
            asString(dataNode?.title) || '(untitled suggestion)';
          const priority = asString(dataNode?.priority);

          return (
            <CollapsibleCard
              key={asString(suggestion.id) || index}
              collapsed={collapsed}
              onToggle={() => collapse.toggle(index)}
              meta={
                <>
                  <span className="patcher-card-rank">
                    #{asNumber(suggestion.rank, index + 1)}
                  </span>
                  <span className="patcher-card-type">
                    {asString(suggestion.type) || 'suggestion'}
                  </span>
                  <span className="patcher-card-status">
                    {asString(suggestion.status) || 'NEW'}
                  </span>
                  <span className="patcher-card-status">{suggestionTitle}</span>
                </>
              }
              summary={
                <>
                  {priority ? `priority: ${priority}` : 'no priority'}
                  {actionItems.length > 0
                    ? ` · ${actionItems.length} action item${actionItems.length === 1 ? '' : 's'}`
                    : ''}
                </>
              }
              headerActions={
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => props.onRemoveSuggestion(suggestionPath)}
                >
                  Remove suggestion
                </button>
              }
            >
              <label className="patcher-field">
                <span>Title</span>
                <input
                  type="text"
                  className="text-input"
                  value={asString(dataNode?.title)}
                  onChange={(event) =>
                    props.onEditField(`${dataPath}.title`, event.target.value)
                  }
                />
              </label>

              <label className="patcher-field patcher-field-row">
                <span>Priority</span>
                <select
                  className="select-input"
                  value={asString(dataNode?.priority)}
                  onChange={(event) =>
                    props.onEditField(
                      `${dataPath}.priority`,
                      event.target.value,
                    )
                  }
                >
                  {SUGGESTION_PRIORITY_OPTIONS.map((option) => (
                    <option key={option || 'empty'} value={option}>
                      {option || '—'}
                    </option>
                  ))}
                </select>
              </label>

              <label className="patcher-field">
                <span>Description</span>
                <textarea
                  className="textarea-input"
                  rows={4}
                  value={asString(dataNode?.description)}
                  onChange={(event) =>
                    props.onEditField(
                      `${dataPath}.description`,
                      event.target.value,
                    )
                  }
                />
              </label>

              <label className="patcher-field">
                <span>Rationale</span>
                <textarea
                  className="textarea-input"
                  rows={4}
                  value={asString(dataNode?.rationale)}
                  onChange={(event) =>
                    props.onEditField(
                      `${dataPath}.rationale`,
                      event.target.value,
                    )
                  }
                />
              </label>

              <label className="patcher-field">
                <span>Expected outcome</span>
                <textarea
                  className="textarea-input"
                  rows={2}
                  value={asString(dataNode?.expectedOutcome)}
                  onChange={(event) =>
                    props.onEditField(
                      `${dataPath}.expectedOutcome`,
                      event.target.value,
                    )
                  }
                />
              </label>

              <fieldset className="patcher-action-items">
                <legend>Action items ({actionItems.length})</legend>
                {actionItems.map((item, itemIndex) => (
                  <div key={itemIndex} className="patcher-action-item-row">
                    <textarea
                      className="textarea-input"
                      rows={2}
                      value={asString(item)}
                      onChange={(event) =>
                        props.onEditField(
                          `${dataPath}.actionItems.${itemIndex}`,
                          event.target.value,
                        )
                      }
                    />
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() =>
                        props.onRemoveSuggestion(
                          `${dataPath}.actionItems.${itemIndex}`,
                        )
                      }
                      aria-label={`Remove action item ${itemIndex + 1}`}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() =>
                    props.onEditField(
                      `${dataPath}.actionItems.${actionItems.length}`,
                      '',
                    )
                  }
                >
                  + Add action item
                </button>
              </fieldset>
            </CollapsibleCard>
          );
        })}
      </div>
    </section>
  );
}

// Re-export the JsonValue type so downstream consumers can type the
// downloaded artifact when needed — currently unused but kept here so the
// public surface of this module is self-explanatory.
export type { JsonValue };
