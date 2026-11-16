/** T-H04 scripted edge cases and manual real-OS file drag rows. */
export const TIMELINE_DND_SCRIPTED_ROWS = [
  { id: 'D-H01', scenario: 'drop onto a locked track; locked track receives no clip' },
  { id: 'D-H02', scenario: 'drop onto an empty timeline; media is placed at the requested time' },
  { id: 'D-H03', scenario: 'drop onto a missing-media clip; report the missing source safely' },
  { id: 'D-H04', scenario: 'drop a ten-minute clip; preserve its full duration' },
  { id: 'D-H05', scenario: 'drop a file while it is being copied; show a retry message' },
  { id: 'D-H06', scenario: 'drop a read-only file; import without modifying the source' },
  { id: 'D-H07', scenario: 'drop unsupported media with an .mp4 extension; reject by content' },
  { id: 'D-H08', scenario: 'drop filenames in Persian and Arabic; preserve both names' },
  { id: 'D-H09', scenario: 'drop a file from a very long path; complete or report a clear error' },
  { id: 'D-H10', scenario: 'drop the same file twice; retain distinct media/clip entries' },
];

/** These rows require a human to drag from Explorer/desktop with the real mouse. */
export const TIMELINE_DND_LIVE_ROWS = [
  {
    id: 'L-H04-1',
    scenario: 'drag one scratch file from Explorer to the timeline, Monitor, and Media panel',
  },
  {
    id: 'L-H04-2',
    scenario: 'drag several scratch files from Explorer to the timeline, Monitor, and Media panel',
  },
  {
    id: 'L-H04-3',
    scenario: 'drag a scratch folder from Explorer to the timeline, Monitor, and Media panel',
  },
  {
    id: 'L-H04-4',
    scenario:
      'drag a temporary desktop scratch file to the timeline, Monitor, and Media panel; remove it',
  },
];
