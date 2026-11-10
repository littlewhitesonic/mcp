export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- 1. CORS 跨域处理 ---
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-mcp-protocol-version",
        },
      });
    }

    // ==========================================
    // --- 2. 模拟 OAUTH 端点 ---
    // ==========================================

    // Grok A 阶段: 授权重定向
    if (url.pathname === "/oauth/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");

      if (!redirectUri) {
        return new Response("Missing redirect_uri parameter", { status: 400 });
      }

      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set("code", "temp_secure_auth_code_123");
      if (state) callbackUrl.searchParams.set("state", state);

      return new Response(null, {
        status: 302,
        headers: { "Location": callbackUrl.toString() }
      });
    }

    // Grok B 阶段: 换取 Access Token
    if (url.pathname === "/oauth/token") {
      let clientSecret = "";
      
      if (request.method === "POST") {
        const contentType = request.headers.get("content-type") || "";
        if (contentType.includes("application/x-www-form-urlencoded")) {
          const formData = await request.formData();
          clientSecret = formData.get("client_secret") || "";
        } else if (contentType.includes("application/json")) {
          const body = await request.json();
          clientSecret = body.client_secret || "";
        }
      }

      const authHeader = request.headers.get("Authorization");
      if (!clientSecret && authHeader && authHeader.startsWith("Basic ")) {
        try {
          const credentials = atob(authHeader.split(" ")[1]);
          clientSecret = credentials.split(":")[1];
        } catch (e) {}
      }

      // 验证 Grok 后台输入的 Client Secret 是否匹配你的 GROK_API_KEY
      const masterKey = env.GROK_API_KEY; 
      if (!masterKey || clientSecret !== masterKey) {
        return new Response(JSON.stringify({ error: "Invalid client_secret provided." }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // 返回长期有效的安全 Token (直接复用你的 GROK_API_KEY 作为 token)
      const tokenResponse = {
        access_token: masterKey, 
        token_type: "Bearer",
        expires_in: 315360000
      };

      return new Response(JSON.stringify(tokenResponse), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // ==========================================
    // --- 3. MCP 核心端点 ---
    // ==========================================

    // --- MCP A: 工具列表 (允许匿名公开访问，让 Grok 顺利发现服务器) ---
    if (request.method === "POST" && url.pathname === "/tools/list") {
      const responseBody = {
        tools: [
          {
            name: "upload_image",
            description: "Downloads an image from a URL and saves it directly to a Hugging Face Bucket or Dataset repository.",
            inputSchema: {
              type: "object",
              properties: {
                imageUrl: {
                  type: "string",
                  description: "The public HTTP/HTTPS URL of the image to fetch and upload."
                },
                fileName: {
                  type: "string",
                  description: "Optional custom name for the file (e.g. image.jpg). If omitted, a timestamp name is generated."
                }
              },
              required: ["imageUrl"]
            }
          }
        ]
      };

      return new Response(JSON.stringify(responseBody), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // --- MCP B: 真正的工具执行 (严加死守，必须验证 Token) ---
    if (request.method === "POST" && url.pathname === "/tools/call") {
      // 拦截无 Token 或 Token 错误的请求
      const authHeader = request.headers.get("Authorization");
      const expectedAuth = env.GROK_API_KEY ? `Bearer ${env.GROK_API_KEY}` : null;

      if (!expectedAuth || authHeader !== expectedAuth) {
        return new Response(JSON.stringify({ error: "Unauthorized custom MCP request." }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      try {
        const body = await request.json();
        
        if (body.name !== "upload_image") {
          return new Response(JSON.stringify({ error: "Unknown tool requested" }), { 
            status: 400,
            headers: { "Access-Control-Allow-Origin": "*" }
          });
        }

        const { imageUrl, fileName } = body.arguments || {};
        if (!imageUrl) {
          throw new Error("Missing required argument: imageUrl");
        }

        // 从 Grok 的生成链接中下载图片
        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) {
          throw new Error(`Failed to download image from source URL (Status ${imageResponse.status})`);
        }

        const blob = await imageResponse.blob();
        const contentType = imageResponse.headers.get("content-type") || "image/png";
        
        let extension = "png";
        if (contentType.includes("jpeg") || contentType.includes("jpg")) extension = "jpg";
        if (contentType.includes("webp")) extension = "webp";

        const finalFileName = fileName || `grok_${Date.now()}.${extension}`;

        const hfToken = env.HF_TOKEN; 
        const repoId = env.HF_REPO_ID; 
        const repoType = env.HF_REPO_TYPE || "dataset"; 

        if (!hfToken || !repoId) {
          throw new Error("Missing server configuration: HF_TOKEN and HF_REPO_ID variables are required.");
        }

        const hfUploadUrl = `https://huggingface.co{repoType}s/${repoId}/upload/${finalFileName}`;

        // 上传 Payload 到 Hugging Face 存储库
        const hfResponse = await fetch(hfUploadUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${hfToken}`,
            "Content-Type": contentType
          },
          body: blob
        });

        if (!hfResponse.ok) {
          const errText = await hfResponse.text();
          throw new Error(`Hugging Face API Error (${hfResponse.status}): ${errText}`);
        }

        const storageUrl = `https://huggingface.co{repoType}s/${repoId}/resolve/main/${finalFileName}`;

        return new Response(JSON.stringify({
          content: [
            {
              type: "text",
              text: `🎯 Photo successfully saved to Hugging Face!\n📁 Filename: ${finalFileName}\n🔗 View/Download Link: ${storageUrl}`
            }
          ]
        }), { 
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } 
        });

      } catch (error) {
        return new Response(JSON.stringify({
          content: [{ type: "text", text: `❌ Storage Error: ${error.message}` }],
          isError: true
        }), { 
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } 
        });
      }
    }

    return new Response("Secure Hugging Face MCP Server running. Ready for Grok handshake.", { status: 200 });
  }
};
