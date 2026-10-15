/**
 * Local stand-in for the Git LFS locking API (no real service): `GET /locks`, `POST /locks`,
 * `POST /locks/verify`, `POST /locks/<id>/unlock` – as the Git LFS API documentation describes
 * them. The server decides who "we" are: locks owned by `me` count as ours in `verify`, new locks
 * get `me` as owner. With `unsupported: true` every route answers 404 (a server without locking).
 *
 *   const server = await startLockServer({ me: "Lena Hartmann" });
 *   git config lfs.url <server.url>
 *   server.seed("daten/karte.psd", "Jonas Berg");
 *   server.paths(); server.count("POST /locks/verify"); await server.close();
 */
import http from "node:http";

const TYPE = "application/vnd.git-lfs+json";

export async function startLockServer({ me = "Lena Hartmann", unsupported = false } = {}) {
  const locks = [];
  const hits = [];
  let nextId = 1;
  const state = { unsupported };

  const send = (res, status, body) => {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "content-type": TYPE, "content-length": data.length });
    res.end(data);
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const route = `${req.method} ${url.pathname}`;
      hits.push(route);
      let body = {};
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      } catch {
        body = {};
      }
      if (state.unsupported) return send(res, 404, { message: "Not Found" });
      if (route === "GET /locks") {
        const path = url.searchParams.get("path");
        const id = url.searchParams.get("id");
        return send(res, 200, { locks: locks.filter((lock) => (!path || lock.path === path) && (!id || lock.id === id)) });
      }
      if (route === "POST /locks/verify") {
        return send(res, 200, { ours: locks.filter((lock) => lock.owner.name === me), theirs: locks.filter((lock) => lock.owner.name !== me) });
      }
      if (route === "POST /locks") {
        const path = String(body.path ?? "");
        const existing = locks.find((lock) => lock.path === path);
        if (existing) return send(res, 409, { lock: existing, message: "already created lock" });
        const lock = { id: String(nextId++), path, owner: { name: me }, locked_at: new Date().toISOString().replace(/\.\d+Z$/, "Z") };
        locks.push(lock);
        return send(res, 201, { lock });
      }
      const unlock = /^POST \/locks\/([^/]+)\/unlock$/.exec(route);
      if (unlock) {
        const index = locks.findIndex((lock) => lock.id === decodeURIComponent(unlock[1]));
        if (index < 0) return send(res, 404, { message: "Not Found" });
        if (locks[index].owner.name !== me && !body.force) return send(res, 403, { message: "You must have admin access to force delete a lock" });
        const [lock] = locks.splice(index, 1);
        return send(res, 200, { lock });
      }
      return send(res, 404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    me,
    /** Adds a lock held by `owner` (default: someone else). */
    seed(path, owner = "Jonas Berg", lockedAt = "2026-10-01T08:30:00Z") {
      const lock = { id: String(nextId++), path, owner: { name: owner }, locked_at: lockedAt };
      locks.push(lock);
      return lock;
    },
    /** Locked paths, sorted. */
    paths: () => locks.map((lock) => lock.path).sort(),
    owners: () => Object.fromEntries(locks.map((lock) => [lock.path, lock.owner.name])),
    count: (route) => hits.filter((hit) => hit === route).length,
    hits: () => [...hits],
    setUnsupported(value) {
      state.unsupported = value;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
