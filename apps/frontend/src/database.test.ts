import { describe, expect, it, vi } from "vite-plus/test";
import type { UrlHeads } from "@automerge/automerge-repo/slim";
import { Database } from "./database";

function historyHandle(count: number, content = "Selected version") {
  const history = Array.from({ length: count }, (_, index) => [String(index)] as UrlHeads);
  return {
    history: () => history,
    metadata: vi.fn(() => ({ time: 100 })),
    view: vi.fn(() => ({ doc: () => ({ content }) })),
  };
}

describe("document history", () => {
  it("lists all metadata without reconstructing historical documents", () => {
    const database = new Database();
    const handle = historyHandle(10000);
    Object.assign(database, { handle });

    const history = database.getHistory();

    expect(history).toHaveLength(10000);
    expect(history[0].id).toBe("9999");
    expect(history[9999].id).toBe("0");
    expect(handle.metadata).toHaveBeenCalledTimes(10000);
    expect(handle.view).not.toHaveBeenCalled();
  });

  it("loads content on selection and uses the currently selected document", () => {
    const database = new Database();
    const first = historyHandle(3, "First document");
    Object.assign(database, { handle: first });
    const [snapshot] = database.getHistory();
    expect(database.getSnapshotContent(snapshot.heads)).toBe("First document");
    expect(first.view).toHaveBeenCalledExactlyOnceWith(snapshot.heads);

    const second = historyHandle(1, "Second document");
    Object.assign(database, { handle: second });
    const [nextSnapshot] = database.getHistory();
    expect(database.getSnapshotContent(nextSnapshot.heads)).toBe("Second document");
    expect(second.view).toHaveBeenCalledExactlyOnceWith(nextSnapshot.heads);
  });
});
