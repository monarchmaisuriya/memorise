import type { PaseoApi } from "./paseo-types";

const TIMELINE_PAGE = 200;
// At most this many pages are read forward at once; the next read continues from where this one ended.
const MAX_TIMELINE_PAGES = 5;

export type TimelineCursor = { epoch: string; seq: number };

// An agent's timeline entries after a saved cursor, paging forward. A rebuilt timeline (new epoch,
// or a cursor Paseo no longer knows), or no cursor, starts again from the most recent page;
// `continued` is false then, so a caller that must not count entries twice can tell.
export async function readTimelineSince(paseo: PaseoApi, agentId: string, previous: TimelineCursor | undefined) {
  const timeline = paseo.agents.ref(agentId).timeline;
  if (previous) {
    const entries = [];
    let cursor = { epoch: previous.epoch, seq: previous.seq };
    for (let pageNumber = 0; pageNumber < MAX_TIMELINE_PAGES; pageNumber += 1) {
      const page = await timeline.refetch({ direction: "after", cursor, limit: TIMELINE_PAGE, projection: "projected" });
      if (page.epoch !== previous.epoch || page.reset || page.staleCursor) break;
      entries.push(...page.entries.filter((entry) => entry.seqEnd > cursor.seq));
      const end = page.entries.at(-1)?.seqEnd;
      if (!page.hasNewer || end === undefined) return { epoch: page.epoch, entries, end: end ?? cursor.seq, continued: true };
      cursor = { epoch: page.epoch, seq: end };
    }
    if (entries.length > 0) return { epoch: previous.epoch, entries, end: cursor.seq, continued: true };
  }
  const tail = await timeline.refetch({ direction: "tail", limit: TIMELINE_PAGE, projection: "projected" });
  return { epoch: tail.epoch, entries: tail.entries, end: tail.entries.at(-1)?.seqEnd ?? 0, continued: false };
}

// Where an agent's timeline ends now, so later reads start after it.
export async function timelineEnd(paseo: PaseoApi, agentId: string): Promise<TimelineCursor> {
  const tail = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 1, projection: "projected" });
  return { epoch: tail.epoch, seq: tail.entries.at(-1)?.seqEnd ?? 0 };
}
