import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Status } from "../core";

const statusGet = vi.fn<(input: { repoId: string }) => Promise<Status>>();

vi.mock("../core", async (original) => ({
  ...(await original<typeof import("../core")>()),
  core: { statusGet: (input: { repoId: string }) => statusGet(input), on: () => () => undefined },
}));

const { qk, queryClient } = await import("./queries");
const { applyStatus, loadStatus, statusTicket, withFreshStatus, withStatus } = await import("./statusCache");
const { readStatus, resetStatusOrder } = await import("./statusOrder");

const REPO = "repo-1";
const key = qk.status(REPO);

/** A status that differs only in its token – that is enough for ordering. */
const status = (token: string): Status => ({ token, unstaged: [], staged: [], conflicted: [] }) as unknown as Status;

/** A promise the test resolves from outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const cached = () => queryClient.getQueryData<Status>(key)?.token;
const fetchStatus = () => queryClient.fetchQuery({ queryKey: key, queryFn: ({ signal }) => readStatus(REPO, signal), staleTime: 0 });
const settle = () => new Promise((done) => setTimeout(done, 0));

beforeEach(() => {
  queryClient.clear();
  resetStatusOrder();
  statusGet.mockReset();
});

describe("Status cache: ordering of command results and queries", () => {
  it("takes over a command's result if nothing has been loaded since", async () => {
    queryClient.setQueryData(key, status("alt"));
    const result = await withStatus(REPO, async () => status("neu"))();
    expect(result.token).toBe("neu");
    expect(cached()).toBe("neu");
  });

  it("a late answer does not overwrite a state loaded after sending", async () => {
    queryClient.setQueryData(key, status("alt"));
    const command = deferred<Status>();
    const pending = withStatus(REPO, () => command.promise)();

    // After sending, a query loads a newer state …
    statusGet.mockResolvedValueOnce(status("neuer"));
    await fetchStatus();
    expect(cached()).toBe("neuer");

    // … and only then does the command's answer arrive. Afterwards it reloads.
    statusGet.mockResolvedValue(status("wahrheit"));
    command.resolve(status("befehl"));
    await pending;
    expect(cached()).toBe("neuer");
    await settle();
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it("a query that started BEFORE sending does not hold up the command's result", async () => {
    queryClient.setQueryData(key, status("alt"));
    const read = deferred<Status>();
    statusGet.mockReturnValueOnce(read.promise);
    const fetching = fetchStatus();

    const command = deferred<Status>();
    const pending = withStatus(REPO, () => command.promise)();

    // The older query lands first, then the command's answer.
    read.resolve(status("von-vorher"));
    await fetching;
    expect(cached()).toBe("von-vorher");
    command.resolve(status("befehl"));
    await pending;
    expect(cached()).toBe("befehl");
  });

  it("a query overtaken by a command result asks again instead of writing older data", async () => {
    const first = deferred<Status>();
    statusGet.mockReturnValueOnce(first.promise).mockResolvedValueOnce(status("nach-dem-befehl"));
    const fetching = fetchStatus();

    applyStatus(statusTicket(REPO), status("befehl"));
    expect(cached()).toBe("befehl");

    first.resolve(status("von-mittendrin"));
    await fetching;
    expect(statusGet).toHaveBeenCalledTimes(2);
    expect(cached()).toBe("nach-dem-befehl");
  });

  it("if the query returns the same as the command, it does not ask again", async () => {
    const first = deferred<Status>();
    statusGet.mockReturnValueOnce(first.promise);
    const fetching = fetchStatus();

    applyStatus(statusTicket(REPO), status("gleich"));
    first.resolve(status("gleich"));
    await fetching;
    expect(statusGet).toHaveBeenCalledTimes(1);
    expect(cached()).toBe("gleich");
  });

  it("of two commands the one sent later wins, even if its answer arrives first", async () => {
    queryClient.setQueryData(key, status("alt"));
    const earlier = statusTicket(REPO);
    const later = statusTicket(REPO);
    expect(applyStatus(later, status("zweiter"))).toBe(true);
    expect(applyStatus(earlier, status("erster"))).toBe(false);
    expect(cached()).toBe("zweiter");
  });

  it("withFreshStatus: the status is reloaded before the command counts as done", async () => {
    statusGet.mockResolvedValueOnce(status("vorher"));
    await fetchStatus();
    statusGet.mockResolvedValueOnce(status("nachher"));
    const value = await withFreshStatus(REPO, async () => "ergebnis")();
    expect(value).toBe("ergebnis");
    expect(cached()).toBe("nachher");
  });

  it("loadStatus does not put anything older over a state taken over in the meantime", async () => {
    const read = deferred<Status>();
    statusGet.mockReturnValueOnce(read.promise).mockResolvedValueOnce(status("frisch"));
    const loading = loadStatus(REPO);
    applyStatus(statusTicket(REPO), status("befehl"));
    read.resolve(status("von-vorher"));
    expect((await loading).token).toBe("frisch");
    expect(cached()).toBe("frisch");
  });
});
