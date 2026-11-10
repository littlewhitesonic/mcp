const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, x-mcp-protocol-version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });

const TOOLS = [
  {
    name: "upload_image",
    description:
      "Downloads an image from a URL and saves it to a Hugging Face repository (dataset/model).",
    inputSchema: {
      type: "object",
      properties: {
        imageUrl: { type: "string", description: "Public HTTP/HTTPS URL of the image." },
        fileName: { type: "string", description: "Optional file name, e.g. image.jpg." },
      },
      required: ["imageUrl"],
    },
  },
];

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function uploadImage(args, env) {
  const { imageUrl, fileName } = args || {};
  if (!imageUrl) throw new Error("Missing required argument: imageUrl");

  const img = await fetch(imageUrl);
  if (!img.ok) throw new Error(`Failed to download image (status ${img.status})`);

  const buf = await img.arrayBuffer();
  const ct = img.headers.get("content-type") || "image/png";
  let ext = "png";
  if (/jpe?g/.test(ct)) ext = "jpg";
  else if (ct.includes("webp")) ext = "webp";
  else if (ct.includes("gif")) ext = "gif";

  const name = fileName || `grok_${Date.now()}.${ext}`;

  const { HF_TOKEN, HF_REPO_ID } = env;
  const repoType = env.HF_REPO_TYPE || "dataset"; // dataset | model | space
  if (!HF_TOKEN || !HF_REPO_ID) throw new Error("Server missing HF_TOKEN / HF_REPO_ID");

  const bytes = new Uint8Array(buf);
  const authH = { Authorization: `Bearer ${HF_TOKEN}` };
  const repoApi = `https://huggingface.co/api/${repoType}s/${HF_REPO_ID}`;
  const repoGit = `https://huggingface.co/${repoType === "model" ? "" : repoType + "s/"}${HF_REPO_ID}.git`;

  // 1) Ask the Hub whether this file must go through LFS/Xet (binary) or can be inline
  const pre = await fetch(`${repoApi}/preupload/main`, {
    method: "POST",
    headers: { ...authH, "Content-Type": "application/json" },
    body: JSON.stringify({ files: [{ path: name, size: bytes.length, sample: toBase64(bytes.slice(0, 512)) }] }),
  });
  if (!pre.ok) throw new Error(`Hugging Face preupload error (${pre.status}): ${await pre.text()}`);
  const mode = (await pre.json()).files?.[0]?.uploadMode || "lfs";

  const lines = [JSON.stringify({ key: "header", value: { summary: `Upload ${name}` } })];

  if (mode === "regular") {
    lines.push(JSON.stringify({ key: "file", value: { content: toBase64(buf), path: name, encoding: "base64" } }));
  } else {
    // 2) LFS upload (the Hub bridges LFS to Xet storage)
    const oid = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const lfsHeaders = { ...authH, Accept: "application/vnd.git-lfs+json", "Content-Type": "application/vnd.git-lfs+json" };

    const batch = await fetch(`${repoGit}/info/lfs/objects/batch`, {
      method: "POST",
      headers: lfsHeaders,
      body: JSON.stringify({
        operation: "upload",
        transfers: ["basic"],
        objects: [{ oid, size: bytes.length }],
        hash_algo: "sha256",
        ref: { name: "main" },
      }),
    });
    if (!batch.ok) throw new Error(`LFS batch error (${batch.status}): ${await batch.text()}`);
    const obj = (await batch.json()).objects?.[0];
    if (obj?.error) throw new Error(`LFS error: ${obj.error.message}`);

    const up = obj?.actions?.upload; // absent => object already stored
    if (up) {
      const put = await fetch(up.href, { method: "PUT", headers: up.header || {}, body: buf });
      if (!put.ok) throw new Error(`LFS upload error (${put.status}): ${await put.text()}`);
      const ver = obj.actions.verify;
      if (ver) {
        const v = await fetch(ver.href, {
          method: "POST",
          headers: { ...(ver.header || {}), ...lfsHeaders },
          body: JSON.stringify({ oid, size: bytes.length }),
        });
        if (!v.ok) throw new Error(`LFS verify error (${v.status}): ${await v.text()}`);
      }
    }
    lines.push(JSON.stringify({ key: "lfsFile", value: { path: name, algo: "sha256", size: bytes.length, oid } }));
  }
  const ndjson = lines.join("\n");

  const commitUrl = `https://huggingface.co/api/${repoType}s/${HF_REPO_ID}/commit/main`;
  const res = await fetch(commitUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${HF_TOKEN}`, "Content-Type": "application/x-ndjson" },
    body: ndjson,
  });
  if (!res.ok) throw new Error(`Hugging Face API error (${res.status}): ${await res.text()}`);

  const prefix = repoType === "model" ? "" : `${repoType}s/`;
  const link = `https://huggingface.co/${prefix}${HF_REPO_ID}/resolve/main/${name}`;
  return `Saved to Hugging Face.\nFile: ${name}\nLink: ${link}`;
}

async function handleRpc(msg, env, request, url) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: params?.protocolVersion || "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "hf-image-uploader", version: "1.0.0" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const auth = request.headers.get("Authorization");
      const keyOk =
        env.GROK_API_KEY &&
        (auth === `Bearer ${env.GROK_API_KEY}` || url.searchParams.get("key") === env.GROK_API_KEY);
      if (!keyOk) {
        return err(-32001, "Unauthorized");
      }
      if (params?.name !== "upload_image") return err(-32602, "Unknown tool");
      try {
        const text = await uploadImage(params.arguments, env);
        return ok({ content: [{ type: "text", text }] });
      } catch (e) {
        return ok({ content: [{ type: "text", text: `Storage error: ${e.message}` }], isError: true });
      }
    }
    default:
      return err(-32601, `Method not found: ${method}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // ---------- OAuth discovery + (mock) flow ----------
    // (OAuth discovery removed: auth is now via ?key=<GROK_API_KEY> in the URL or a Bearer header)
    if (url.pathname === "/oauth/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      if (!redirectUri) return new Response("Missing redirect_uri", { status: 400 });
      const cb = new URL(redirectUri);
      cb.searchParams.set("code", "temp_secure_auth_code_123");
      if (state) cb.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { Location: cb.toString() } });
    }
    if (url.pathname === "/oauth/token") {
      let secret = "";
      const ct = request.headers.get("content-type") || "";
      if (request.method === "POST") {
        if (ct.includes("application/x-www-form-urlencoded")) {
          secret = (await request.formData()).get("client_secret") || "";
        } else if (ct.includes("application/json")) {
          secret = (await request.json()).client_secret || "";
        }
      }
      const basic = request.headers.get("Authorization");
      if (!secret && basic?.startsWith("Basic ")) {
        try { secret = atob(basic.split(" ")[1]).split(":")[1] || ""; } catch (_) {}
      }
      if (!env.GROK_API_KEY || secret !== env.GROK_API_KEY) {
        return json({ error: "invalid_client" }, 401);
      }
      return json({ access_token: env.GROK_API_KEY, token_type: "Bearer", expires_in: 315360000 });
    }

    // ---------- MCP (Streamable HTTP, JSON-RPC 2.0) at / or /mcp ----------
    if (url.pathname === "/" || url.pathname === "/mcp") {
      if (request.method === "GET") {
        // No server-initiated SSE stream
        return new Response("Method Not Allowed", { status: 405, headers: CORS });
      }
      if (request.method === "POST") {
        let body;
        try { body = await request.json(); }
        catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }

        if (Array.isArray(body)) {
          const out = [];
          for (const m of body) {
            if (m.id === undefined) continue; // notification
            out.push(await handleRpc(m, env, request, url));
          }
          return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
        }
        if (body.id === undefined) {
          // notification, e.g. notifications/initialized
          return new Response(null, { status: 202, headers: CORS });
        }
        return json(await handleRpc(body, env, request, url));
      }
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
