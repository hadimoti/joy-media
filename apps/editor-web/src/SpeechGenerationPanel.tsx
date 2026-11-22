import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type {
  SpeechConsentRequest,
  SpeechLanguage,
  SpeechSynthesisTiming,
  SpeechSynthesizeV1,
} from '@joy-media/job-protocol';
import { parseSpeechSynthesisTiming } from '@joy-media/job-protocol';
import './SpeechGenerationPanel.css';

export type SpeechModelId = SpeechSynthesizeV1['modelId'] | 'faster-whisper-large-v3-turbo';
export type SpeechModelState = 'ready' | 'setup-required' | 'incompatible';

export interface SpeechModelStatus {
  readonly modelId: SpeechModelId;
  readonly state: SpeechModelState;
  readonly reasonCode?: string;
}

export interface SpeechReferenceAsset {
  readonly id: string;
  readonly label: string;
}

export interface SpeechGenerationResult {
  readonly availability: 'ready' | 'setup-required';
  readonly timing?: SpeechSynthesisTiming;
}

export interface SpeechGenerationOptions {
  readonly referenceAssetId?: string;
  readonly consent: SpeechConsentRequest;
  readonly signal: AbortSignal;
}

export interface SpeechGenerationPanelProps {
  readonly modelStatus: readonly SpeechModelStatus[];
  /** Registered audio assets from the current project, never filesystem paths. */
  readonly referenceAssets: readonly SpeechReferenceAsset[];
  readonly onGenerate: (
    request: SpeechSynthesizeV1,
    options: SpeechGenerationOptions,
  ) => Promise<SpeechGenerationResult>;
  readonly onAddCaptions?: (timing: SpeechSynthesisTiming) => void;
  readonly onOpenLocalAssets: () => void;
  readonly onOpenSavedSetup?: () => void;
  readonly progress?: number;
}

const ENGINE_LABEL: Readonly<Record<SpeechModelId, string>> = {
  'faster-whisper-large-v3-turbo': 'Faster Whisper large-v3-turbo',
  'kokoro-82m': 'Kokoro 82M',
  'chatterbox-en': 'Chatterbox English',
  'chatterbox-fa': 'Chatterbox Persian',
};

const SYNTHESIS_ENGINES: readonly Exclude<SpeechModelId, 'faster-whisper-large-v3-turbo'>[] = [
  'kokoro-82m',
  'chatterbox-en',
  'chatterbox-fa',
];

function engineSupportsLanguage(engine: SpeechModelId, language: SpeechLanguage): boolean {
  if (engine === 'kokoro-82m' || engine === 'chatterbox-en') return language === 'en-US';
  return engine === 'chatterbox-fa' && language === 'fa-IR';
}

function statusText(state: SpeechModelState): string {
  switch (state) {
    case 'ready':
      return 'Ready';
    case 'setup-required':
      return 'Setup required';
    case 'incompatible':
      return 'Incompatible';
  }
}

function errorMessage(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { readonly code?: unknown }).code)
      : '';
  switch (code) {
    case 'SETUP_REQUIRED':
      return 'This speech engine needs local setup. Open Local assets, install it, then restart JOY Media.';
    case 'SOURCE_UNAVAILABLE':
      return 'The selected reference audio is no longer available in this project.';
    case 'CONSENT_DENIED':
      return 'Speech generation needs your explicit purpose and consent choices.';
    case 'CANCELED':
      return 'Generation canceled.';
    default:
      return error instanceof Error ? error.message : 'Speech generation failed. Try again.';
  }
}

export function SpeechGenerationPanel({
  modelStatus,
  referenceAssets,
  onGenerate,
  onAddCaptions,
  onOpenLocalAssets,
  onOpenSavedSetup,
  progress,
}: SpeechGenerationPanelProps): ReactElement {
  const statusId = useId();
  const textId = useId();
  const engineId = useId();
  const languageId = useId();
  const referenceId = useId();
  const currentJob = useRef<AbortController | undefined>(undefined);
  const composing = useRef(false);
  const [language, setLanguage] = useState<SpeechLanguage>('en-US');
  const [engineChoice, setEngineChoice] = useState<SpeechModelId>('kokoro-82m');
  const [text, setText] = useState('');
  const [referenceAssetId, setReferenceAssetId] = useState('');
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('Ready to generate speech locally.');
  const [error, setError] = useState<string>();
  const [captionTiming, setCaptionTiming] = useState<SpeechSynthesisTiming>();

  const engineChoices = SYNTHESIS_ENGINES.filter(
    (engine) =>
      engineSupportsLanguage(engine, language) &&
      modelStatus.find((model) => model.modelId === engine)?.state !== 'incompatible',
  );
  const selectedEngine =
    engineChoices.find(
      (engine) =>
        engine === engineChoice &&
        modelStatus.find((model) => model.modelId === engine)?.state === 'ready',
    ) ??
    engineChoices.find(
      (engine) => modelStatus.find((model) => model.modelId === engine)?.state === 'ready',
    ) ??
    engineChoices[0];
  const selectedEngineStatus = modelStatus.find((model) => model.modelId === selectedEngine);
  useEffect(() => {
    setReferenceAssetId('');
    setConsent(false);
  }, [selectedEngine]);
  const transcriberStatus = modelStatus.find(
    (model) => model.modelId === 'faster-whisper-large-v3-turbo',
  );
  const selectedAssetIsRegistered =
    referenceAssetId.length === 0 || referenceAssets.some((asset) => asset.id === referenceAssetId);
  const referenceRequired = language === 'fa-IR';
  const validReference =
    selectedAssetIsRegistered && (!referenceRequired || referenceAssetId.length > 0);
  const canGenerate =
    !pending &&
    !composing.current &&
    text.trim().length > 0 &&
    validReference &&
    selectedEngineStatus?.state === 'ready' &&
    consent;
  const safeProgress =
    typeof progress === 'number' && Number.isFinite(progress)
      ? Math.max(0, Math.min(100, progress))
      : 0;

  const cancel = () => {
    currentJob.current?.abort();
    currentJob.current = undefined;
    setPending(false);
    setStatus('Generation canceled.');
  };

  const generate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canGenerate || selectedEngine === undefined || composing.current) return;
    const controller = new AbortController();
    currentJob.current = controller;
    setError(undefined);
    setCaptionTiming(undefined);
    setPending(true);
    setStatus('Generating speech locally.');

    const request: SpeechSynthesizeV1 = {
      schemaVersion: 1,
      language,
      modelId: selectedEngine,
      text,
      ...(selectedEngine === 'chatterbox-fa' ? { purpose: 'personal-noncommercial' as const } : {}),
    };
    const options: SpeechGenerationOptions = {
      consent: { acknowledged: true, purpose: 'general' },
      signal: controller.signal,
      ...(referenceAssetId.length > 0 ? { referenceAssetId } : {}),
    };

    try {
      const result = await onGenerate(request, options);
      if (controller.signal.aborted) return;
      if (result.availability === 'setup-required') {
        setStatus('Speech engine setup is required. Install local assets and restart JOY Media.');
        return;
      }
      const trustedTiming = parseSpeechSynthesisTiming(result.timing);
      if (
        trustedTiming !== undefined &&
        trustedTiming.timingSource !== 'unavailable' &&
        trustedTiming.words.length > 0
      ) {
        setCaptionTiming(trustedTiming);
      }
      setStatus('Speech generation complete.');
    } catch (caught) {
      if (controller.signal.aborted) return;
      const message = errorMessage(caught);
      setError(message);
      setStatus(message);
    } finally {
      if (!controller.signal.aborted) {
        setPending(false);
        currentJob.current = undefined;
      }
    }
  };

  return (
    <section className="speech-generation-panel" aria-labelledby={`${statusId}-heading`}>
      <header className="speech-generation-header">
        <h2 id={`${statusId}-heading`}>Generate speech</h2>
        <span className="speech-local-badge">Local processing</span>
      </header>

      <section className="speech-model-status" aria-label="Local speech model status">
        <h3>Local model status</h3>
        {modelStatus.map((model) => (
          <div className="speech-model-status-row" key={model.modelId}>
            <span>{ENGINE_LABEL[model.modelId]}</span>
            <span className={`speech-state speech-state-${model.state}`}>
              {statusText(model.state)}
            </span>
            {model.reasonCode !== undefined && <small>{model.reasonCode}</small>}
          </div>
        ))}
        {modelStatus.some((model) => model.state === 'setup-required') && (
          <p className="speech-setup-hint">
            Install speech models from Local assets, then restart JOY Media to refresh their status.
          </p>
        )}
        <div className="speech-setup-actions">
          <button type="button" onClick={onOpenLocalAssets}>
            Open Local assets
          </button>
          {onOpenSavedSetup !== undefined && (
            <button type="button" onClick={onOpenSavedSetup}>
              Open saved custom setup
            </button>
          )}
        </div>
      </section>

      <section className="speech-transcription-setup" aria-label="Speech-to-text setup">
        <h3>Speech-to-text setup</h3>
        {transcriberStatus?.state === 'ready' ? (
          <p>Faster Whisper is ready for local transcription.</p>
        ) : (
          <p>
            Speech-to-text setup required. Find Faster Whisper in Local assets. You can also use an
            optional saved custom setup. Install it and restart JOY Media before transcribing.
          </p>
        )}
      </section>

      <form onSubmit={(event) => void generate(event)}>
        <div className="speech-field-row">
          <label htmlFor={languageId}>Language</label>
          <select
            id={languageId}
            name="language"
            value={language}
            disabled={pending}
            onChange={(event) => {
              const next = event.currentTarget.value as SpeechLanguage;
              setLanguage(next);
              setEngineChoice(next === 'fa-IR' ? 'chatterbox-fa' : 'kokoro-82m');
              setReferenceAssetId('');
              setConsent(false);
              setCaptionTiming(undefined);
            }}
          >
            <option value="en-US">English</option>
            <option value="fa-IR">Persian</option>
          </select>
        </div>

        <div className="speech-field-row">
          <label htmlFor={engineId}>Speech engine</label>
          <select
            id={engineId}
            name="engine"
            value={selectedEngine ?? ''}
            disabled={pending}
            onChange={(event) => {
              const next = event.currentTarget.value as SpeechModelId;
              setEngineChoice(next);
              setConsent(false);
              if (next === 'kokoro-82m') {
                setReferenceAssetId('');
              }
            }}
          >
            {engineChoices.map((engine) => {
              const state =
                modelStatus.find((model) => model.modelId === engine)?.state ?? 'setup-required';
              return (
                <option key={engine} value={engine} disabled={state !== 'ready'}>
                  {ENGINE_LABEL[engine]} · {statusText(state)}
                </option>
              );
            })}
          </select>
        </div>
        {selectedEngine === 'chatterbox-fa' && (
          <p className="speech-license-notice">
            Chatterbox Persian Expressive by Ramin Mahmoodi - CC-BY-NC-4.0 - for non-commercial use
            only
          </p>
        )}
        {selectedEngineStatus?.state !== 'ready' && (
          <p className="speech-setup-hint" role="status">
            This engine needs local setup. Install it from Local assets and restart JOY Media.
          </p>
        )}

        <div className="speech-field-row">
          <label htmlFor={referenceId}>
            {referenceRequired ? 'Persian reference required' : 'Optional English reference'}
          </label>
          <select
            id={referenceId}
            name="referenceAssetId"
            value={referenceAssetId}
            disabled={pending || selectedEngine === 'kokoro-82m'}
            required={referenceRequired}
            onChange={(event) => {
              setReferenceAssetId(event.currentTarget.value);
              setConsent(false);
            }}
          >
            <option value="">{referenceRequired ? 'Choose project audio' : 'No reference'}</option>
            {referenceAssets.map((asset) => (
              <option value={asset.id} key={asset.id}>
                {asset.label}
              </option>
            ))}
          </select>
        </div>

        <label className="speech-text-label" htmlFor={textId}>
          Text to speak
        </label>
        <textarea
          id={textId}
          name="text"
          value={text}
          dir={language === 'fa-IR' ? 'rtl' : 'auto'}
          lang={language}
          rows={5}
          disabled={pending}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            setText(event.currentTarget.value);
          }}
          onChange={(event) => setText(event.currentTarget.value)}
        />

        <fieldset className="speech-consent-group" disabled={pending}>
          <legend>Purpose and consent</legend>
          <label>
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.currentTarget.checked)}
            />
            I have permission to use this reference voice and consent to generating this text
          </label>
        </fieldset>

        {error !== undefined && (
          <p className="speech-error" role="alert">
            {error}
          </p>
        )}
        <p id={statusId} className="speech-live-status" role="status" aria-live="polite">
          {status}
        </p>
        {pending && (
          <div className="speech-progress" aria-label="Speech generation progress">
            <progress max={100} value={safeProgress} />
            <span>{Math.round(safeProgress)}%</span>
          </div>
        )}
        <div className="speech-action-row">
          {pending ? (
            <button type="button" onClick={cancel} aria-label="Cancel generation">
              Cancel generation
            </button>
          ) : (
            <button type="submit" disabled={!canGenerate}>
              Generate
            </button>
          )}
          {captionTiming !== undefined && onAddCaptions !== undefined && (
            <button type="button" onClick={() => onAddCaptions(captionTiming)}>
              Add captions
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
