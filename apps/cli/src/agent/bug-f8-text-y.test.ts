// F8: the agent was told "y … 0 is centered", but y=0 is the template's bottom title line and
// y was clamped to ±0.4 around it, so the top half of the frame was unreachable and "near the
// bottom" requests moved text up (h3).
import { describe, expect, it } from 'vitest';
import { createJoyAgentTools } from '@joy-media/joy-agent-engine';
import { CliJoyAgentToolBridge } from './bridge.js';
import { createTextClip } from '../render/text-clip.js';
import { ffmpegCaptionY, layoutFfmpegCaption } from '../render/caption-layout.js';
import { fixtureProject } from './scripted-agent.test-helper.js';

function topOf(y: number): number | undefined {
  const { document, clip } = createTextClip({
    id: 't',
    text: 'Top',
    startUs: 0,
    durationUs: 1_000_000,
    y,
  });
  const [line] = layoutFfmpegCaption({
    clipId: clip.id,
    document,
    segment: document.segments[0]!,
    style: clip.style,
    width: 1920,
    height: 1080,
  });
  return line === undefined ? undefined : ffmpegCaptionY(line, 1080);
}

describe('F8: text y semantics', () => {
  it('the create-text description says y=0 is the bottom title line, not the centre', () => {
    const tools = createJoyAgentTools(new CliJoyAgentToolBridge(fixtureProject({}), 1) as never);
    const description = String(
      (tools as Record<string, { description?: string }>).propose_document_operations!.description,
    );
    expect(description).not.toMatch(/0 is centered and omitted values default to center/);
    expect(description).toMatch(/y.{0,80}bottom/i);
  });

  it('a negative y can place text in the top half of the frame', async () => {
    const bridge = new CliJoyAgentToolBridge(fixtureProject({}), 1);
    const result = (await bridge.proposeDocumentOperations({
      operations: [
        {
          kind: 'create-text',
          id: 'top',
          text: 'Top',
          startUs: 0,
          durationUs: 1_000_000,
          y: -0.7,
          dependsOn: [],
        },
      ],
    })) as { accepted: boolean };
    expect(result.accepted).toBe(true);
    expect(topOf(-0.7)!).toBeLessThan(1080 / 2);
  });

  it('a y that would push the text out of the frame is rejected at proposal time', async () => {
    const bridge = new CliJoyAgentToolBridge(fixtureProject({}), 1);
    const result = (await bridge.proposeDocumentOperations({
      operations: [
        {
          kind: 'create-text',
          id: 'off',
          text: 'Off',
          startUs: 0,
          durationUs: 1_000_000,
          y: -0.95,
          dependsOn: [],
        },
      ],
    })) as { accepted: boolean };
    expect(result.accepted).toBe(false);
  });
});
