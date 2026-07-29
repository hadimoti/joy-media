export type ImportedAsset = {
  id: string;
  filePath: string;
  title: string;
  category: string;
  description: string;
  tags: string[];
  sourceFile: string;
};

type ManifestAsset = ImportedAsset & { exported?: boolean };

export function importAlphaAssetManifest(payload: {
  assets: ManifestAsset[];
}): ImportedAsset[] {
  return payload.assets
    .filter((asset) => asset.exported !== false)
    .map(({ id, filePath, title, category, description, tags, sourceFile }) => ({
      id,
      filePath,
      title,
      category,
      description,
      tags,
      sourceFile,
    }));
}
