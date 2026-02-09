const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const httpProxy = require("http-proxy");
const cookie = require("cookie");

const app = express();
app.use(express.json());

app.use(bodyParser.raw({ type: "*/*", limit: "100mb" }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const proxy = httpProxy.createProxyServer({ ws: true });

// id -> { ws, target }
const tunnels = new Map();

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Agent connects here
  if (url.pathname === "/connect") {
    const id = url.searchParams.get("id");
    if (!id) return socket.destroy();

    wss.handleUpgrade(req, socket, head, (ws) => {
      tunnels.set(id, { ws, target: null });
      console.log("Agent connected:", id);

      ws.on("message", (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.type === "register") {
            if (!data.target.startsWith("http://localhost:")) {
              ws.close();
              return;
            }
            tunnels.get(id).target = data.target;
            console.log(`Registered target for ${id}:`, data.target);
          }
        } catch {}
      });

      ws.on("close", () => {
        tunnels.delete(id);
        console.log("Agent disconnected:", id);
      });
    });
    return;
  }

  // Proxy WebSocket (HMR etc.) based on cookie
  const cookies = cookie.parse(req.headers.cookie || "");
  const id = cookies.tunnel;

  const tunnel = tunnels.get(id);
  if (!tunnel || !tunnel.target) return socket.destroy();

  proxy.ws(req, socket, head, {
    target: tunnel.target,
    changeOrigin: true,
  });
});

app.post("/select-tunnel", express.json(), (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "Missing id" });

  if (!tunnels.has(id)) {
    return res.status(404).json({ error: "Tunnel not connected" });
  }

  // Set cookie for browser
  res.setHeader("Set-Cookie", `tunnel=${id}; Path=/; HttpOnly; SameSite=Lax`);

  res.json({ ok: true, selected: id });
});

app.all("*", async (req, res) => {
  const cookies = require("cookie").parse(req.headers.cookie || "");
  const id = cookies.tunnel;

  if (!id) return res.status(400).send("Missing tunnel cookie");

  const tunnel = tunnels.get(id);
  if (!tunnel || !tunnel.ws) {
    return res.status(502).send("No active tunnel");
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);

    const payload = {
      method: req.method,
      path: req.originalUrl,
      headers: req.headers,
      body: body.length ? body.toString("base64") : null,
    };

    tunnel.ws.send(JSON.stringify(payload));

    tunnel.ws.once("message", (msg) => {
      const resp = JSON.parse(msg.toString());

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

      if (resp.body) {
        res.send(Buffer.from(resp.body, "base64"));
      } else {
        res.end();
      }
    });
  });
});

server.listen(process.env.PORT || 8080, () => {
  console.log("Relay listening");
});
