export default {
  async fetch(request, env) {
    // Handle CORS preflight requests from Grok.com
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-mcp-protocol-version",
        },
      });
    }

    // --- SECURITY ACCESS CHECK ---
    // Enforce authorization so strangers cannot exploit your worker.
    const authHeader = request.headers.get("Authorization");
    const expectedAuth = env.GROK_API_KEY ? `Bearer ${env.GROK_API_KEY}` : null;

    // Only enforce if you have set the GROK_API_KEY variable in your Cloudflare dashboard
    if (expectedAuth && authHeader !== expectedAuth) {
      return new Response(JSON.stringify({ error: "Unauthorized access attempt." }), {
        status: 401,
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*" 
        }
      });
    }

    const url = new URL(request.url);

    // --- 1. MCP Handshake / List Tools ---
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
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*" 
        }
      });
    }

    // --- 2. MCP Tool Execution (The Upload Trigger) ---
    if (request.method === "POST" && url.pathname === "/tools/call") {
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

        // Fetch image from Grok's generated image link
        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) {
          throw new Error(`Failed to download image from source URL (Status ${imageResponse.status})`);
        }

        const blob = await imageResponse.blob();
        const contentType = imageResponse.headers.get("content-type") || "image/png";
        
        // Infer file extension or fallback
        let extension = "png";
        if (contentType.includes("jpeg") || contentType.includes("jpg")) extension = "jpg";
        if (contentType.includes("webp")) extension = "webp";

        // Generate unique filename
        const finalFileName = fileName || `grok_${Date.now()}.${extension}`;

        // Get Environment Variables configured in the Cloudflare Dashboard
        const hfToken = env.HF_TOKEN; 
        const repoId = env.HF_REPO_ID; // format: "username/bucket-name"
        const repoType = env.HF_REPO_TYPE || "dataset"; // "bucket" or "dataset"

        if (!hfToken || !repoId) {
          throw new Error("Missing server configuration: Ensure HF_TOKEN and HF_REPO_ID variables are set in the Cloudflare dashboard.");
        }

        const hfUploadUrl = `https://huggingface.co{repoType}s/${repoId}/upload/${finalFileName}`;

        // Upload the image payload to the Hugging Face Hub
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
          headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*" 
          } 
        });

      } catch (error) {
        return new Response(JSON.stringify({
          content: [{ type: "text", text: `❌ Storage Error: ${error.message}` }],
          isError: true
        }), { 
          headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*" 
          } 
        });
      }
    }

    return new Response("Hugging Face MCP Server running on Cloudflare Workers", { status: 200 });
  }
};
