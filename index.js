const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cookie = require("cookie");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// id -> ws
const tunnels = new Map();

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/connect") return socket.destroy();

  const id = url.searchParams.get("id");
  if (!id) return socket.destroy();

  wss.handleUpgrade(req, socket, head, (ws) => {
    tunnels.set(id, ws);
    console.log("Agent connected:", id);
    ws.on("close", () => tunnels.delete(id));
  });
});

// pick tunnel (cookie)
app.post("/select-tunnel", express.json(), (req, res) => {
  const { id } = req.body || {};
  if (!id || !tunnels.has(id)) return res.status(400).json({ error: "Bad id" });
  res.setHeader("Set-Cookie", `tunnel=${id}; Path=/; SameSite=Lax`);
  res.json({ ok: true });
});

// forward ALL http to agent
app.all("*", (req, res) => {
  const cookies = cookie.parse(req.headers.cookie || "");
  const id = cookies.tunnel;
  if (!id) return res.status(400).send("Missing tunnel cookie");

  const ws = tunnels.get(id);
  if (!ws) return res.status(502).send("No active tunnel");

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const rid = uuidv4();

    ws.send(
      JSON.stringify({
        rid,
        method: req.method,
        path: req.originalUrl,
        headers: req.headers,
        body: body.length ? body.toString("base64") : null,
      }),
    );

    const onMsg = (msg) => {
      const resp = JSON.parse(msg.toString());
      if (resp.rid !== rid) return;
      ws.off("message", onMsg);

      res.status(resp.status || 200);
      if (resp.headers) {
        for (const [k, v] of Object.entries(resp.headers)) {
          if (
            !["transfer-encoding", "content-length"].includes(k.toLowerCase())
          ) {
            res.setHeader(k, v);
          }
        }
      }
      if (resp.body) res.send(Buffer.from(resp.body, "base64"));
      else res.end();
    };

    ws.on("message", onMsg);
  });
});

server.listen(process.env.PORT || 8080, () => {
  console.log("Relay listening");
});
