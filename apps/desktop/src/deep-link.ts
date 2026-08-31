export interface ProjectDeepLink {
  readonly projectId: string;
}
const PROJECT_LINK =
  /^joy:\/\/open\/project\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
export function parseProjectDeepLink(value: string): ProjectDeepLink | undefined {
  const match = PROJECT_LINK.exec(value);
  return match?.[1] ? { projectId: match[1] } : undefined;
}
