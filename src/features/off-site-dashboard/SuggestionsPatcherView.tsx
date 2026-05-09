import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchOpportunitySuggestionsRaw,
  fetchSiteOpportunitySummaries,
  patchSuggestion,
  type RawOpportunitySummary,
  type RawSuggestion,
} from './api';
import type {
  CanonicalOpportunityType,
  SiteDashboardResult,
  SpacecatProxyConfig,
} from './types';

// The patcher is for off-site sources only — backend opportunity types like
// "site-audit" or other non-off-site categories are filtered out of the
// dropdown so they can't be opened here. Keep this Set in sync with the
// off-site lanes elsewhere in the dashboard.
const OFF_SITE_OPPORTUNITY_TYPES = new Set<CanonicalOpportunityType>([
  'Reddit',
  'YouTube',
  'Cited URLs',
  'Wikipedia',
]);

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: string }
  | { kind: 'error'; message: string };

interface PatcherDraftFields {
  title: string;
  description: string;
  rationale: string;
  expectedOutcome: string;
  priority: string;
  persona: string;
  actionItems: string[];
}

interface DraftEntry {
  fields: PatcherDraftFields;
  // The exact original snapshot used for dirty checks and Reset.
  originalFields: PatcherDraftFields;
  // The full original `data` object so we can preserve fields we don't expose
  // (e.g., bindings) when sending PATCH requests.
  originalData: Record<string, unknown>;
}

const PRIORITY_OPTIONS = ['high', 'medium', 'low'] as const;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function buildDraftFromSuggestion(suggestion: RawSuggestion): DraftEntry {
  const data = suggestion.data ?? {};
  const fields: PatcherDraftFields = {
    title: asString(data.title),
    description: asString(data.description),
    rationale: asString(data.rationale),
    expectedOutcome: asString(data.expectedOutcome),
    priority: asString(data.priority),
    persona: asString(data.persona),
    actionItems: asStringArray(data.actionItems),
  };
  return {
    fields,
    originalFields: { ...fields, actionItems: [...fields.actionItems] },
    originalData: { ...data },
  };
}

function fieldsAreDirty(fields: PatcherDraftFields, original: PatcherDraftFields): boolean {
  if (fields.title !== original.title) return true;
  if (fields.description !== original.description) return true;
  if (fields.rationale !== original.rationale) return true;
  if (fields.expectedOutcome !== original.expectedOutcome) return true;
  if (fields.priority !== original.priority) return true;
  if (fields.persona !== original.persona) return true;
  if (fields.actionItems.length !== original.actionItems.length) return true;
  for (let i = 0; i < fields.actionItems.length; i += 1) {
    if (fields.actionItems[i] !== original.actionItems[i]) return true;
  }
  return false;
}

/**
 * Required-field validation. SpaceCat's LLMO UI hides any suggestion whose
 * title is missing, so saving an empty title effectively makes the row
 * disappear. Priority is also a required field on the backend. We block save
 * (with an inline error) until both are present.
 */
function validateFields(fields: PatcherDraftFields): string[] {
  const errors: string[] = [];
  if (!fields.title.trim()) errors.push('Title is required.');
  if (!fields.priority.trim()) errors.push('Priority is required.');
  return errors;
}

/**
 * Summarize what's about to change so the confirm panel can show the user
 * exactly which fields they're touching before the PATCH fires. For action
 * items, we show count delta and add/remove counts since full diffs would
 * bloat the panel.
 */
function describeChanges(
  fields: PatcherDraftFields,
  original: PatcherDraftFields,
): string[] {
  const changes: string[] = [];
  if (fields.title !== original.title) changes.push('Title');
  if (fields.priority !== original.priority) changes.push('Priority');
  if (fields.persona !== original.persona) changes.push('Persona');
  if (fields.description !== original.description) changes.push('Description');
  if (fields.rationale !== original.rationale) changes.push('Rationale');
  if (fields.expectedOutcome !== original.expectedOutcome) {
    changes.push('Expected outcome');
  }

  const before = original.actionItems.map((entry) => entry.trim()).filter(Boolean);
  const after = fields.actionItems.map((entry) => entry.trim()).filter(Boolean);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const removed = before.filter((entry) => !afterSet.has(entry)).length;
  const added = after.filter((entry) => !beforeSet.has(entry)).length;
  const orderChanged =
    before.length === after.length && before.some((entry, idx) => entry !== after[idx]);

  if (added > 0 || removed > 0 || orderChanged) {
    const deltaParts: string[] = [];
    if (added > 0) deltaParts.push(`+${added} added`);
    if (removed > 0) deltaParts.push(`-${removed} removed`);
    if (orderChanged && deltaParts.length === 0) deltaParts.push('order changed');
    changes.push(
      `Action items (${before.length} → ${after.length}${
        deltaParts.length > 0 ? `, ${deltaParts.join(', ')}` : ''
      })`,
    );
  }

  return changes;
}

interface UndoSnapshot {
  fields: PatcherDraftFields;
  data: Record<string, unknown>;
  capturedAt: string;
}

/**
 * Build the data payload to send in a PATCH.
 *
 * IMPORTANT: SpaceCat's PATCH on /suggestions/{id} REPLACES the entire `data`
 * object rather than merging fields into it. So even if only one field changed,
 * we MUST send a complete data object — otherwise unspecified fields like
 * title, priority, description, rationale would be wiped on the server.
 *
 * We layer the user's edits on top of the originalData snapshot we captured
 * at fetch time. This preserves any fields we don't expose in the editor
 * (e.g., bindings, internal IDs, server-computed values) along with whatever
 * the user changed.
 *
 * Empty action-item lines are stripped so the server receives a clean array.
 */
function buildPatchPayload(
  fields: PatcherDraftFields,
  originalData: Record<string, unknown>,
): Record<string, unknown> {
  const cleanedActionItems = fields.actionItems
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    ...originalData,
    title: fields.title,
    description: fields.description,
    rationale: fields.rationale,
    expectedOutcome: fields.expectedOutcome,
    priority: fields.priority,
    persona: fields.persona,
    actionItems: cleanedActionItems,
  };
}

interface SuggestionsPatcherViewProps {
  apiBaseUrl: string;
  apiKey: string;
  proxyConfig: SpacecatProxyConfig;
  siteCards: SiteDashboardResult[];
}

export function SuggestionsPatcherView(props: SuggestionsPatcherViewProps) {
  const sitesWithIds = useMemo(
    () =>
      props.siteCards.filter(
        (card): card is SiteDashboardResult & { siteId: string } =>
          typeof card.siteId === 'string' && card.siteId.length > 0,
      ),
    [props.siteCards],
  );

  const [selectedSiteId, setSelectedSiteId] = useState<string>('');
  const [opportunities, setOpportunities] = useState<RawOpportunitySummary[] | null>(null);
  const [loadingOpportunities, setLoadingOpportunities] = useState(false);
  const [opportunitiesError, setOpportunitiesError] = useState<string | null>(null);

  const [selectedOpportunityId, setSelectedOpportunityId] = useState<string>('');
  const [suggestions, setSuggestions] = useState<RawSuggestion[] | null>(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);

  const [drafts, setDrafts] = useState<Record<string, DraftEntry>>({});
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [pasteErrors, setPasteErrors] = useState<Record<string, string>>({});
  // Inline validation errors per card — populated when Save is pressed with
  // missing required fields. Cleared as soon as the user retries Save with
  // valid input.
  const [validationErrors, setValidationErrors] = useState<Record<string, string[]>>({});
  // Per-card "are you sure?" panel state. When non-null, Save is pending the
  // user's confirmation; the array lists which fields will be sent.
  const [pendingConfirm, setPendingConfirm] = useState<Record<string, string[]>>({});
  // Per-card snapshot of the server state BEFORE the most recent successful
  // save, so the user can one-click Undo back to it. Cleared on a fresh
  // load, on a successful Undo, or on subsequent Save.
  const [undoSnapshots, setUndoSnapshots] = useState<Record<string, UndoSnapshot>>({});

  const isReady = props.proxyConfig.configured || props.apiKey.trim().length > 0;

  // The dropdown only shows the four off-site opportunity types (Reddit,
  // YouTube, Cited URLs, Wikipedia). Each row carries its canonical label
  // alongside the original raw type so the option text can read e.g.
  // "Cited URLs — Top cited URLs analysis…" instead of "cited-analysis…".
  const offSiteOpportunityOptions = useMemo(() => {
    const filtered: Array<{
      opportunity: RawOpportunitySummary;
      canonical: CanonicalOpportunityType;
    }> = [];
    for (const opportunity of opportunities ?? []) {
      // Trust the canonical type pre-computed by the API helper — it uses
      // the same two-step classifier (type string → tag/signal inference)
      // as the Opportunities tab, so the patcher dropdown's count matches
      // the sidebar's "Cited URLs / Reddit / YouTube / Wikipedia" badges.
      const canonical = opportunity.canonicalType;
      if (canonical && OFF_SITE_OPPORTUNITY_TYPES.has(canonical)) {
        filtered.push({ opportunity, canonical });
      }
    }
    return filtered;
  }, [opportunities]);

  // If the currently-selected opportunity disappears from the filtered list
  // (e.g. site changed, opportunity reload trimmed it out, or filter set
  // tightened in a future change), clear the selection so the suggestions
  // panel doesn't try to render against a stale id.
  useEffect(() => {
    if (!selectedOpportunityId) return;
    if (
      !offSiteOpportunityOptions.some(
        (entry) => entry.opportunity.id === selectedOpportunityId,
      )
    ) {
      setSelectedOpportunityId('');
    }
  }, [offSiteOpportunityOptions, selectedOpportunityId]);

  // Reset dependent state when the selected site changes.
  useEffect(() => {
    setOpportunities(null);
    setOpportunitiesError(null);
    setSelectedOpportunityId('');
    setSuggestions(null);
    setSuggestionsError(null);
    setDrafts({});
    setSaveStates({});
    setPasteErrors({});
    setValidationErrors({});
    setPendingConfirm({});
    setUndoSnapshots({});
  }, [selectedSiteId]);

  // Load opportunities for the selected site.
  useEffect(() => {
    if (!selectedSiteId || !isReady) return;
    let cancelled = false;
    setLoadingOpportunities(true);
    setOpportunitiesError(null);
    fetchSiteOpportunitySummaries({
      apiBaseUrl: props.apiBaseUrl,
      apiKey: props.apiKey,
      siteId: selectedSiteId,
      proxyConfig: props.proxyConfig,
    })
      .then((items) => {
        if (cancelled) return;
        setOpportunities(items);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Failed to load opportunities.';
        setOpportunitiesError(message);
        setOpportunities([]);
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingOpportunities(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSiteId, isReady, props.apiBaseUrl, props.apiKey, props.proxyConfig]);

  // Load suggestions for the selected opportunity.
  useEffect(() => {
    if (!selectedSiteId || !selectedOpportunityId || !isReady) return;
    let cancelled = false;
    setLoadingSuggestions(true);
    setSuggestionsError(null);
    fetchOpportunitySuggestionsRaw({
      apiBaseUrl: props.apiBaseUrl,
      apiKey: props.apiKey,
      siteId: selectedSiteId,
      opportunityId: selectedOpportunityId,
      proxyConfig: props.proxyConfig,
    })
      .then((items) => {
        if (cancelled) return;
        // Sort by rank ascending (lowest rank is highest priority in this API).
        const sorted = [...items].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
        setSuggestions(sorted);
        setDrafts(
          sorted.reduce<Record<string, DraftEntry>>((acc, suggestion) => {
            acc[suggestion.id] = buildDraftFromSuggestion(suggestion);
            return acc;
          }, {}),
        );
        setSaveStates(
          sorted.reduce<Record<string, SaveState>>((acc, suggestion) => {
            acc[suggestion.id] = { kind: 'idle' };
            return acc;
          }, {}),
        );
        setPasteErrors({});
        setValidationErrors({});
        setPendingConfirm({});
        setUndoSnapshots({});
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Failed to load suggestions.';
        setSuggestionsError(message);
        setSuggestions([]);
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingSuggestions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    selectedSiteId,
    selectedOpportunityId,
    isReady,
    props.apiBaseUrl,
    props.apiKey,
    props.proxyConfig,
  ]);

  const updateField = useCallback(
    (suggestionId: string, key: keyof PatcherDraftFields, value: string) => {
      setDrafts((prev) => {
        const entry = prev[suggestionId];
        if (!entry) return prev;
        if (key === 'actionItems') return prev; // handled separately
        return {
          ...prev,
          [suggestionId]: {
            ...entry,
            fields: { ...entry.fields, [key]: value },
          },
        };
      });
    },
    [],
  );

  const updateActionItem = useCallback(
    (suggestionId: string, index: number, value: string) => {
      setDrafts((prev) => {
        const entry = prev[suggestionId];
        if (!entry) return prev;
        const nextActionItems = entry.fields.actionItems.map((item, idx) =>
          idx === index ? value : item,
        );
        return {
          ...prev,
          [suggestionId]: {
            ...entry,
            fields: { ...entry.fields, actionItems: nextActionItems },
          },
        };
      });
    },
    [],
  );

  const addActionItem = useCallback((suggestionId: string) => {
    setDrafts((prev) => {
      const entry = prev[suggestionId];
      if (!entry) return prev;
      return {
        ...prev,
        [suggestionId]: {
          ...entry,
          fields: {
            ...entry.fields,
            actionItems: [...entry.fields.actionItems, ''],
          },
        },
      };
    });
  }, []);

  const removeActionItem = useCallback((suggestionId: string, index: number) => {
    setDrafts((prev) => {
      const entry = prev[suggestionId];
      if (!entry) return prev;
      return {
        ...prev,
        [suggestionId]: {
          ...entry,
          fields: {
            ...entry.fields,
            actionItems: entry.fields.actionItems.filter((_, idx) => idx !== index),
          },
        },
      };
    });
  }, []);

  const resetDraft = useCallback((suggestionId: string) => {
    setDrafts((prev) => {
      const entry = prev[suggestionId];
      if (!entry) return prev;
      return {
        ...prev,
        [suggestionId]: {
          ...entry,
          fields: {
            ...entry.originalFields,
            actionItems: [...entry.originalFields.actionItems],
          },
        },
      };
    });
    setSaveStates((prev) => ({ ...prev, [suggestionId]: { kind: 'idle' } }));
    setPasteErrors((prev) => {
      const next = { ...prev };
      delete next[suggestionId];
      return next;
    });
    setValidationErrors((prev) => {
      const next = { ...prev };
      delete next[suggestionId];
      return next;
    });
    setPendingConfirm((prev) => {
      const next = { ...prev };
      delete next[suggestionId];
      return next;
    });
  }, []);

  const copyDraftJson = useCallback(
    async (suggestionId: string) => {
      const entry = drafts[suggestionId];
      if (!entry) return;
      const payload = {
        title: entry.fields.title,
        description: entry.fields.description,
        rationale: entry.fields.rationale,
        expectedOutcome: entry.fields.expectedOutcome,
        priority: entry.fields.priority,
        persona: entry.fields.persona,
        actionItems: entry.fields.actionItems,
      };
      try {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        setPasteErrors((prev) => {
          const next = { ...prev };
          delete next[suggestionId];
          return next;
        });
      } catch (error) {
        setPasteErrors((prev) => ({
          ...prev,
          [suggestionId]: error instanceof Error ? error.message : 'Failed to copy.',
        }));
      }
    },
    [drafts],
  );

  const pasteDraftJson = useCallback(async (suggestionId: string) => {
    try {
      const text = await navigator.clipboard.readText();
      const parsed = JSON.parse(text) as Partial<PatcherDraftFields>;
      setDrafts((prev) => {
        const entry = prev[suggestionId];
        if (!entry) return prev;
        return {
          ...prev,
          [suggestionId]: {
            ...entry,
            fields: {
              title: typeof parsed.title === 'string' ? parsed.title : entry.fields.title,
              description:
                typeof parsed.description === 'string'
                  ? parsed.description
                  : entry.fields.description,
              rationale:
                typeof parsed.rationale === 'string'
                  ? parsed.rationale
                  : entry.fields.rationale,
              expectedOutcome:
                typeof parsed.expectedOutcome === 'string'
                  ? parsed.expectedOutcome
                  : entry.fields.expectedOutcome,
              priority:
                typeof parsed.priority === 'string' ? parsed.priority : entry.fields.priority,
              persona:
                typeof parsed.persona === 'string' ? parsed.persona : entry.fields.persona,
              actionItems: Array.isArray(parsed.actionItems)
                ? parsed.actionItems.filter(
                    (item): item is string => typeof item === 'string',
                  )
                : entry.fields.actionItems,
            },
          },
        };
      });
      setPasteErrors((prev) => {
        const next = { ...prev };
        delete next[suggestionId];
        return next;
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to read or parse JSON from clipboard.';
      setPasteErrors((prev) => ({ ...prev, [suggestionId]: message }));
    }
  }, []);

  // Send a PATCH with the user's edits, capture the pre-save state for Undo,
  // and update the cached drafts/suggestions with the server's response. Used
  // by both Save (after confirm) and the Undo button (which sends a PATCH
  // back to the previous server state).
  const sendPatch = useCallback(
    async (
      suggestionId: string,
      fieldsToSend: PatcherDraftFields,
      baseData: Record<string, unknown>,
      undoCapture?: UndoSnapshot,
    ): Promise<void> => {
      if (!selectedSiteId || !selectedOpportunityId) return;
      const payload = buildPatchPayload(fieldsToSend, baseData);

      setSaveStates((prev) => ({ ...prev, [suggestionId]: { kind: 'saving' } }));
      try {
        const updated = await patchSuggestion({
          apiBaseUrl: props.apiBaseUrl,
          apiKey: props.apiKey,
          siteId: selectedSiteId,
          opportunityId: selectedOpportunityId,
          suggestionId,
          partialData: payload,
          proxyConfig: props.proxyConfig,
        });
        // Treat the server's response as the new canonical original.
        const refreshed = buildDraftFromSuggestion(updated);
        setDrafts((prev) => ({ ...prev, [suggestionId]: refreshed }));
        setSuggestions((prev) =>
          prev
            ? prev.map((suggestion) =>
                suggestion.id === suggestionId ? updated : suggestion,
              )
            : prev,
        );
        setSaveStates((prev) => ({
          ...prev,
          [suggestionId]: { kind: 'saved', at: new Date().toISOString() },
        }));
        // Update the undo snapshot: store the pre-save state so a subsequent
        // Undo PATCHes back to it. If undoCapture is undefined (e.g., the
        // caller IS the Undo button), clear the snapshot — once you undo,
        // there's nothing to redo.
        if (undoCapture) {
          setUndoSnapshots((prev) => ({ ...prev, [suggestionId]: undoCapture }));
        } else {
          setUndoSnapshots((prev) => {
            const next = { ...prev };
            delete next[suggestionId];
            return next;
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to save.';
        setSaveStates((prev) => ({
          ...prev,
          [suggestionId]: { kind: 'error', message },
        }));
      }
    },
    [
      selectedSiteId,
      selectedOpportunityId,
      props.apiBaseUrl,
      props.apiKey,
      props.proxyConfig,
    ],
  );

  // Step 1 of save: validate and (if valid) open the confirm panel. Does NOT
  // send the PATCH yet — the user has to click "Confirm save" to do that.
  const requestSave = useCallback(
    (suggestionId: string) => {
      const entry = drafts[suggestionId];
      if (!entry) return;
      if (!fieldsAreDirty(entry.fields, entry.originalFields)) return;

      const errors = validateFields(entry.fields);
      if (errors.length > 0) {
        setValidationErrors((prev) => ({ ...prev, [suggestionId]: errors }));
        // Clear any stale pending-confirm so we don't show both at once.
        setPendingConfirm((prev) => {
          const next = { ...prev };
          delete next[suggestionId];
          return next;
        });
        return;
      }

      setValidationErrors((prev) => {
        const next = { ...prev };
        delete next[suggestionId];
        return next;
      });
      setPendingConfirm((prev) => ({
        ...prev,
        [suggestionId]: describeChanges(entry.fields, entry.originalFields),
      }));
    },
    [drafts],
  );

  // Step 2 of save: user clicked "Confirm save" in the confirm panel. Capture
  // the pre-save state for Undo, fire the PATCH, then dismiss the panel.
  const confirmSave = useCallback(
    async (suggestionId: string) => {
      const entry = drafts[suggestionId];
      if (!entry) return;
      const undoCapture: UndoSnapshot = {
        fields: {
          ...entry.originalFields,
          actionItems: [...entry.originalFields.actionItems],
        },
        data: { ...entry.originalData },
        capturedAt: new Date().toISOString(),
      };
      // Optimistically dismiss the confirm panel — sendPatch will re-show
      // a Save error pill if the request fails.
      setPendingConfirm((prev) => {
        const next = { ...prev };
        delete next[suggestionId];
        return next;
      });
      await sendPatch(suggestionId, entry.fields, entry.originalData, undoCapture);
    },
    [drafts, sendPatch],
  );

  const cancelConfirm = useCallback((suggestionId: string) => {
    setPendingConfirm((prev) => {
      const next = { ...prev };
      delete next[suggestionId];
      return next;
    });
  }, []);

  // PATCH the server back to the snapshot we captured before the previous
  // save. The Undo button is only visible when an undoSnapshot exists, so the
  // user can never undo into nothing.
  const undoLastSave = useCallback(
    async (suggestionId: string) => {
      const snapshot = undoSnapshots[suggestionId];
      if (!snapshot) return;
      await sendPatch(suggestionId, snapshot.fields, snapshot.data);
    },
    [undoSnapshots, sendPatch],
  );

  return (
    <div className="workspace-mode-stack">
      <section className="panel panel-tone-warm panel-mode-intro">
        <div className="panel-header">
          <div>
            <h2>Suggestions Patcher</h2>
            <p>
              Pick a site and an opportunity to load its suggestions. Edit any field —
              title, description, rationale, expected outcome, priority, persona, or
              action items — and save. Use Copy / Paste JSON to move a suggestion's
              content between rows. Reset reverts a card to the server's last value.
            </p>
          </div>
        </div>
      </section>

      <section className="panel panel-tone-neutral">
        <div className="panel-header">
          <div>
            <h3>Choose opportunity</h3>
            <p>Site list comes from your refreshed dashboard sites.</p>
          </div>
        </div>

        <div className="patcher-pickers">
          <label className="patcher-picker-field">
            <span className="filter-label">Site</span>
            <select
              className="select-input"
              value={selectedSiteId}
              onChange={(event) => setSelectedSiteId(event.target.value)}
            >
              <option value="">— Select a site —</option>
              {sitesWithIds.map((card) => (
                <option key={card.siteId} value={card.siteId}>
                  {card.requestSite}
                </option>
              ))}
            </select>
          </label>

          <label className="patcher-picker-field">
            <span className="filter-label">Opportunity</span>
            <select
              className="select-input"
              value={selectedOpportunityId}
              onChange={(event) => setSelectedOpportunityId(event.target.value)}
              disabled={!selectedSiteId || loadingOpportunities || !opportunities}
            >
              <option value="">
                {loadingOpportunities
                  ? 'Loading...'
                  : offSiteOpportunityOptions.length > 0
                    ? '— Select an off-site opportunity —'
                    : opportunities
                      ? 'No off-site opportunities for this site'
                      : 'No opportunities loaded yet'}
              </option>
              {offSiteOpportunityOptions.map(({ opportunity, canonical }) => (
                <option key={opportunity.id} value={opportunity.id}>
                  {opportunity.title
                    ? `${canonical} — ${opportunity.title.slice(0, 80)}`
                    : `${canonical} (${opportunity.id.slice(0, 8)}…)`}
                </option>
              ))}
            </select>
          </label>
        </div>

        {opportunitiesError ? (
          <p className="status-pill status-pill-error">{opportunitiesError}</p>
        ) : null}
        {!isReady ? (
          <p className="metric-copy">
            Set an API key (or enable the managed relay) to load opportunities.
          </p>
        ) : null}
        {sitesWithIds.length === 0 ? (
          <p className="metric-copy">
            No site IDs are available yet. Run a dashboard refresh first so the
            patcher knows which siteId to call against.
          </p>
        ) : null}
      </section>

      {selectedOpportunityId ? (
        <section className="panel panel-tone-neutral">
          <div className="panel-header">
            <div>
              <h3>Suggestions</h3>
              <p>
                {loadingSuggestions
                  ? 'Loading suggestions…'
                  : suggestions
                    ? `${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'} loaded.`
                    : 'No suggestions loaded.'}
              </p>
            </div>
          </div>

          {suggestionsError ? (
            <p className="status-pill status-pill-error">{suggestionsError}</p>
          ) : null}

          <div className="patcher-card-grid">
            {(suggestions ?? []).map((suggestion) => {
              const draft = drafts[suggestion.id];
              if (!draft) return null;
              const dirty = fieldsAreDirty(draft.fields, draft.originalFields);
              const saveState = saveStates[suggestion.id] ?? { kind: 'idle' };
              const pasteError = pasteErrors[suggestion.id];
              const validationErrorList = validationErrors[suggestion.id] ?? [];
              const confirmList = pendingConfirm[suggestion.id];
              const undoSnapshot = undoSnapshots[suggestion.id];
              const isSaving = saveState.kind === 'saving';
              const confirmActive = Array.isArray(confirmList);

              return (
                <article key={suggestion.id} className="patcher-card">
                  <header className="patcher-card-header">
                    <div className="patcher-card-meta">
                      <span className="patcher-card-rank">
                        #{suggestion.rank ?? '?'}
                      </span>
                      <span className="patcher-card-type">{suggestion.type}</span>
                      <span className="patcher-card-status">
                        {suggestion.status ?? 'NEW'}
                      </span>
                      {dirty ? (
                        <span className="patcher-card-dirty">Unsaved changes</span>
                      ) : null}
                    </div>
                    <code className="patcher-card-id" title={suggestion.id}>
                      {suggestion.id.slice(0, 8)}…
                    </code>
                  </header>

                  <label className="patcher-field">
                    <span>Title</span>
                    <input
                      type="text"
                      className="text-input"
                      value={draft.fields.title}
                      onChange={(event) =>
                        updateField(suggestion.id, 'title', event.target.value)
                      }
                    />
                  </label>

                  <label className="patcher-field patcher-field-row">
                    <span>Priority</span>
                    <select
                      className="select-input"
                      value={draft.fields.priority}
                      onChange={(event) =>
                        updateField(suggestion.id, 'priority', event.target.value)
                      }
                    >
                      <option value="">—</option>
                      {PRIORITY_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="patcher-field">
                    <span>Persona</span>
                    <input
                      type="text"
                      className="text-input"
                      value={draft.fields.persona}
                      onChange={(event) =>
                        updateField(suggestion.id, 'persona', event.target.value)
                      }
                    />
                  </label>

                  <label className="patcher-field">
                    <span>Description (How to improve)</span>
                    <textarea
                      className="textarea-input"
                      rows={4}
                      value={draft.fields.description}
                      onChange={(event) =>
                        updateField(suggestion.id, 'description', event.target.value)
                      }
                    />
                  </label>

                  <label className="patcher-field">
                    <span>Rationale (Why this needs improvement)</span>
                    <textarea
                      className="textarea-input"
                      rows={4}
                      value={draft.fields.rationale}
                      onChange={(event) =>
                        updateField(suggestion.id, 'rationale', event.target.value)
                      }
                    />
                  </label>

                  <label className="patcher-field">
                    <span>Expected outcome</span>
                    <textarea
                      className="textarea-input"
                      rows={2}
                      value={draft.fields.expectedOutcome}
                      onChange={(event) =>
                        updateField(suggestion.id, 'expectedOutcome', event.target.value)
                      }
                    />
                  </label>

                  <fieldset className="patcher-action-items">
                    <legend>Action items ({draft.fields.actionItems.length})</legend>
                    {draft.fields.actionItems.map((item, index) => (
                      <div key={index} className="patcher-action-item-row">
                        <textarea
                          className="textarea-input"
                          rows={2}
                          value={item}
                          onChange={(event) =>
                            updateActionItem(suggestion.id, index, event.target.value)
                          }
                        />
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => removeActionItem(suggestion.id, index)}
                          aria-label={`Remove action item ${index + 1}`}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => addActionItem(suggestion.id)}
                    >
                      + Add action item
                    </button>
                  </fieldset>

                  {pasteError ? (
                    <p className="status-pill status-pill-error">{pasteError}</p>
                  ) : null}
                  {validationErrorList.length > 0 ? (
                    <div className="patcher-validation-errors">
                      <strong>Cannot save:</strong>
                      <ul>
                        {validationErrorList.map((message) => (
                          <li key={message}>{message}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {saveState.kind === 'error' ? (
                    <p className="status-pill status-pill-error">
                      Save failed: {saveState.message}
                    </p>
                  ) : null}
                  {saveState.kind === 'saved' ? (
                    <p className="status-pill status-pill-success">
                      Saved at {new Date(saveState.at).toLocaleTimeString()}
                    </p>
                  ) : null}

                  {confirmActive ? (
                    <div className="patcher-confirm-panel">
                      <strong>About to save these changes:</strong>
                      {confirmList && confirmList.length > 0 ? (
                        <ul>
                          {confirmList.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="metric-copy">No detectable field changes.</p>
                      )}
                      <div className="patcher-confirm-actions">
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() => void confirmSave(suggestion.id)}
                          disabled={isSaving}
                        >
                          {isSaving ? 'Saving…' : 'Confirm save'}
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => cancelConfirm(suggestion.id)}
                          disabled={isSaving}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="patcher-card-actions">
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => requestSave(suggestion.id)}
                      disabled={!dirty || isSaving || confirmActive}
                    >
                      {isSaving ? 'Saving…' : 'Save'}
                    </button>
                    {undoSnapshot ? (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => void undoLastSave(suggestion.id)}
                        disabled={isSaving || confirmActive}
                        title={`Undo the save from ${new Date(
                          undoSnapshot.capturedAt,
                        ).toLocaleTimeString()}`}
                      >
                        Undo last save
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => resetDraft(suggestion.id)}
                      disabled={!dirty || isSaving || confirmActive}
                    >
                      Reset to original
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => void copyDraftJson(suggestion.id)}
                      disabled={isSaving}
                    >
                      Copy JSON
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => void pasteDraftJson(suggestion.id)}
                      disabled={isSaving || confirmActive}
                    >
                      Paste JSON
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
