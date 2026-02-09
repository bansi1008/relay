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

app.all("*", (req, res) => {
  const cookies = cookie.parse(req.headers.cookie || "");
  const id = cookies.tunnel;

  if (!id) return res.status(400).send("Missing tunnel cookie");

  const tunnel = tunnels.get(id);
  if (!tunnel || !tunnel.target) {
    return res.status(502).send("No active tunnel / target not registered");
  }

  proxy.web(req, res, {
    target: tunnel.target,
    changeOrigin: true,
    ws: true,
    xfwd: true,
  });
});

server.listen(process.env.PORT || 8080, () => {
  console.log("Relay listening");
});
