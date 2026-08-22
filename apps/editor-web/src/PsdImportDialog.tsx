import { useEffect, useMemo, useState } from 'react';
import { PanelShell } from './PanelShell.js';
import { BrowserControlPlaneClient } from './control-plane-client.js';
import { openOpfsOriginalAssetCache } from './opfs-original-asset-cache.js';
import {
  buildPsdDocumentSnapshot,
  parsePsdFile,
  registerPsdAssets,
  type PsdLayerMapping,
  type PsdParseResult,
} from './psd-import.js';
import type { EditorSession } from './editor-session.js';

export function PsdImportDialog({
  session,
  projectId,
  onClose,
  showToast,
}: {
  readonly session: EditorSession;
  readonly projectId: string;
  readonly onClose: () => void;
  readonly showToast: (message: string, kind: 'info' | 'success' | 'error') => void;
}) {
  const client = useMemo(() => new BrowserControlPlaneClient(), []);
  const [file, setFile] = useState<File | undefined>(undefined);
  const [parsed, setParsed] = useState<PsdParseResult | undefined>(undefined);
  const [mappings, setMappings] = useState<Readonly<Record<string, PsdLayerMapping>>>({});
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (file === undefined) {
      setParsed(undefined);
      setMappings({});
      setStatus(undefined);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setStatus(`Reading ${file.name}…`);
    void parsePsdFile(file)
      .then((result) => {
        if (cancelled) return;
        setParsed(result);
        setMappings(
          Object.fromEntries(result.layers.map((layer) => [layer.id, defaultMapping(layer.type)])),
        );
        setStatus(`${result.layers.length} layers found (${result.width}×${result.height}).`);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setParsed(undefined);
          setStatus(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const apply = async () => {
    if (file === undefined || parsed === undefined) return;
    setBusy(true);
    setStatus('Registering the PSD and selected raster layers…');
    try {
      const cache = await openOpfsOriginalAssetCache();
      const selectedLayerIds = parsed.layers
        .filter((layer) => mappings[layer.id] !== 'ignore')
        .map((layer) => layer.id);
      const assets = await registerPsdAssets({
        client,
        projectId,
        cache,
        file,
        parsed,
        selectedLayerIds,
      });
      const nextDocument = buildPsdDocumentSnapshot(
        session.visualProject,
        parsed,
        mappings,
        assets,
        parsed.sha256.slice(0, 12),
      );
      session.dispatchCompound(`Import PSD ${file.name}`, { document: nextDocument });
      showToast('PSD imported into the document', 'success');
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`PSD import failed: ${message}`);
      showToast('PSD import failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelShell title="Import PSD" className="psd-import-dialog">
      <div role="dialog" aria-modal="true" aria-label="Import PSD" className="psd-import-surface">
        <div className="psd-import-actions">
          <input
            type="file"
            accept=".psd,image/vnd.adobe.photoshop"
            aria-label="Choose PSD file"
            disabled={busy}
            onChange={(event) => setFile(event.currentTarget.files?.[0])}
          />
          <button type="button" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
        {status !== undefined && (
          <p role={parsed === undefined && file !== undefined && !busy ? 'alert' : 'status'}>
            {status}
          </p>
        )}
        {parsed !== undefined && (
          <>
            {parsed.warnings.length > 0 && (
              <ul className="psd-import-warnings" aria-label="PSD fidelity warnings">
                {parsed.warnings.map((warning) => (
                  <li key={`${warning.layerId}-${warning.code}`}>{warning.message}</li>
                ))}
              </ul>
            )}
            <div className="psd-import-layers" aria-label="PSD layers">
              {parsed.layers.map((layer) => (
                <label key={layer.id} className="psd-layer-row">
                  <span className="psd-layer-name" dir="auto">
                    {layer.name}
                  </span>
                  <select
                    aria-label={`Mapping for ${layer.name}`}
                    value={mappings[layer.id] ?? 'ignore'}
                    onChange={(event) =>
                      setMappings((current) => ({
                        ...current,
                        [layer.id]: event.target.value as PsdLayerMapping,
                      }))
                    }
                    disabled={busy}
                  >
                    <option value="image-object">Image object</option>
                    <option value="text-object" disabled={layer.type !== 'text'}>
                      Text object
                    </option>
                    <option value="flatten-group">Flatten group</option>
                    <option value="ignore">Ignore</option>
                  </select>
                </label>
              ))}
            </div>
            <button type="button" onClick={() => void apply()} disabled={busy}>
              Import selected layers
            </button>
          </>
        )}
      </div>
    </PanelShell>
  );
}

function defaultMapping(type: PsdParseResult['layers'][number]['type']): PsdLayerMapping {
  if (type === 'raster') return 'image-object';
  if (type === 'text') return 'text-object';
  if (type === 'group') return 'flatten-group';
  return 'ignore';
}
