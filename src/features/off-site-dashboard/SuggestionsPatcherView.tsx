import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchOpportunitySuggestionsRaw,
  fetchSiteOpportunitySummaries,
  patchSuggestion,
  type RawOpportunitySummary,
  type RawSuggestion,
} from './api';
import type {
  SiteDashboardResult,
  SpacecatProxyConfig,
} from './types';

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
 * Build the partial-data payload to send in a PATCH. We send only fields that
 * actually changed AND scrub out empty action-item lines so the server gets a
 * clean array.
 */
function buildPatchPayload(
  fields: PatcherDraftFields,
  original: PatcherDraftFields,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (fields.title !== original.title) payload.title = fields.title;
  if (fields.description !== original.description) payload.description = fields.description;
  if (fields.rationale !== original.rationale) payload.rationale = fields.rationale;
  if (fields.expectedOutcome !== original.expectedOutcome) {
    payload.expectedOutcome = fields.expectedOutcome;
  }
  if (fields.priority !== original.priority) payload.priority = fields.priority;
  if (fields.persona !== original.persona) payload.persona = fields.persona;

  const cleanedActionItems = fields.actionItems.map((item) => item.trim()).filter(Boolean);
  const cleanedOriginalActionItems = original.actionItems
    .map((item) => item.trim())
    .filter(Boolean);
  const actionItemsChanged =
    cleanedActionItems.length !== cleanedOriginalActionItems.length ||
    cleanedActionItems.some((item, idx) => item !== cleanedOriginalActionItems[idx]);
  if (actionItemsChanged) {
    payload.actionItems = cleanedActionItems;
  }

  return payload;
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

  const isReady = props.proxyConfig.configured || props.apiKey.trim().length > 0;

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

  const saveDraft = useCallback(
    async (suggestionId: string) => {
      const entry = drafts[suggestionId];
      if (!entry) return;
      if (!selectedSiteId || !selectedOpportunityId) return;
      const partial = buildPatchPayload(entry.fields, entry.originalFields);
      if (Object.keys(partial).length === 0) return;

      setSaveStates((prev) => ({ ...prev, [suggestionId]: { kind: 'saving' } }));
      try {
        const updated = await patchSuggestion({
          apiBaseUrl: props.apiBaseUrl,
          apiKey: props.apiKey,
          siteId: selectedSiteId,
          opportunityId: selectedOpportunityId,
          suggestionId,
          partialData: partial,
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
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to save.';
        setSaveStates((prev) => ({
          ...prev,
          [suggestionId]: { kind: 'error', message },
        }));
      }
    },
    [
      drafts,
      selectedSiteId,
      selectedOpportunityId,
      props.apiBaseUrl,
      props.apiKey,
      props.proxyConfig,
    ],
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
                  : opportunities && opportunities.length > 0
                    ? '— Select an opportunity —'
                    : 'No opportunities loaded yet'}
              </option>
              {(opportunities ?? []).map((opportunity) => (
                <option key={opportunity.id} value={opportunity.id}>
                  {opportunity.title
                    ? `${opportunity.type} — ${opportunity.title.slice(0, 80)}`
                    : `${opportunity.type} (${opportunity.id.slice(0, 8)}…)`}
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

                  <div className="patcher-card-actions">
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => void saveDraft(suggestion.id)}
                      disabled={!dirty || saveState.kind === 'saving'}
                    >
                      {saveState.kind === 'saving' ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => resetDraft(suggestion.id)}
                      disabled={!dirty || saveState.kind === 'saving'}
                    >
                      Reset to original
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => void copyDraftJson(suggestion.id)}
                    >
                      Copy JSON
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => void pasteDraftJson(suggestion.id)}
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
