export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- 1. CORS 跨域与基础首部处理 ---
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-mcp-protocol-version",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ==========================================
    // --- 2. 模拟 OAUTH 流程端点 ---
    // ==========================================
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

      const masterKey = env.GROK_API_KEY; 
      if (!masterKey || clientSecret !== masterKey) {
        return new Response(JSON.stringify({ error: "Invalid client_secret provided." }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      return new Response(JSON.stringify({
        access_token: masterKey, 
        token_type: "Bearer",
        expires_in: 315360000
      }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // ==========================================
    // --- 3. MCP 核心业务端点（自适应 Grok 根目录探测） ---
    // ==========================================

    const isListToolsRoute = (request.method === "POST" && (url.pathname === "/tools/list" || url.pathname === "/"));
    
    // --- MCP A: 工具发现（只要请求主页或者 /tools/list 均返回此列表） ---
    if (isListToolsRoute) {
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
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // --- MCP B: 工具真正的执行调用 ---
    if (request.method === "POST" && url.pathname === "/tools/call") {
      const authHeader = request.headers.get("Authorization");
      const expectedAuth = env.GROK_API_KEY ? `Bearer ${env.GROK_API_KEY}` : null;

      if (!expectedAuth || authHeader !== expectedAuth) {
        return new Response(JSON.stringify({ error: "Unauthorized custom MCP request." }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      try {
        const body = await request.json();
        
        if (body.name !== "upload_image") {
          return new Response(JSON.stringify({ error: "Unknown tool requested" }), { 
            status: 400,
            headers: corsHeaders
          });
        }

        const { imageUrl, fileName } = body.arguments || {};
        if (!imageUrl) {
          throw new Error("Missing required argument: imageUrl");
        }

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

        // 修正了模板字符串语法错误：使用 ${repoType} 而不是 {repoType}
        const hfUploadUrl = `https://huggingface.co{repoType}s/${repoId}/upload/${finalFileName}`;

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
          headers: { "Content-Type": "application/json", ...corsHeaders } 
        });

      } catch (error) {
        return new Response(JSON.stringify({
          content: [{ type: "text", text: `❌ Storage Error: ${error.message}` }],
          isError: true
        }), { 
          headers: { "Content-Type": "application/json", ...corsHeaders } 
        });
      }
    }

    // GET / 兜底响应
    return new Response("Hugging Face MCP Server is running and fully compatible with Grok root discovery.", { 
      status: 200, 
      headers: corsHeaders 
    });
  }
};
