import { corsHeaders, mimeTypes } from './utils'

export async function handleDeleteFile(request, env, ctx) {
    const url = new URL(request.url);

    const filePath = decodeURIComponent(url.pathname.slice(1)); // Remove leading slash
    if (filePath.includes("..")) {
        return new Response("Invalid path", { status: 400 });
    }
    try {
        await env.MY_BUCKET.delete(filePath);

        let dir = "/";
        if (filePath.includes("/")) {
            const idx = filePath.lastIndexOf("/");
            dir = idx > 0 ? "/" + filePath.substring(0, idx) : "/";
        }

        const listingUrl = new URL(dir, url.origin).toString();
        const cache = caches.default;
        const cacheKey = new Request(listingUrl, { cf: { cacheTtl: 604800 } });
        ctx.waitUntil(cache.delete(cacheKey));

        return new Response('File deleted successfully', { status: 200 });
    } catch (error) {
        return new Response('Failed to delete file', { status: 500 });
    }
}

export async function handleMultpleUploads(request, env, ctx) {
    const formData = await request.formData();
    const results = [];
    for (const entry of formData.entries()) {
        const [fieldName, file] = entry;
        if (file instanceof File) {
            const filename = file.name;
            const extension = filename.split(".").pop().toLowerCase();
            const contentType = mimeTypes[extension] || mimeTypes.default;
            const data = await file.arrayBuffer();
            const sanitizedFilename = filename.replace(/^\/+/, ""); //remove leading slashes
            if (filename.includes("..")) { // Block path traversal
                return new Response("Invalid path", { status: 400 });
            }
            if (!sanitizedFilename) return new Response("Invalid filename", { status: 400 });
            try {
                await env.MY_BUCKET.put(sanitizedFilename, data, { httpMetadata: { contentType } });
                results.push({ sanitizedFilename, status: "success", contentType });
                //console.log(request.url)

                const cache = caches.default;
                const cacheKey = new Request(new URL("/", request.url).toString(), { cf: { cacheTtl: 604800 } });
                ctx.waitUntil(cache.delete(cacheKey));

            } catch (error) {
                //console.log("wtf");
                results.push({ filename, status: "failed", error: error.message });
            }
        }
    }

    return new Response(JSON.stringify(results), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

export async function handleGetFile(request, env) {
    let path = new URL(request.url).pathname;
    const filename = decodeURIComponent(path.slice(1));
    if(path === '/'){
        path = '/dav'
        return new Response(handleUiRouting(path), {
            status:301,
            headers: {
                "Content-Type": "text/html",
                "Cache-Control": "public, max-age=604800"
            },
        });

    }
    const file = await env.MY_BUCKET.get(filename);

    if (file === null) {
        return new Response("File not found", { status: 404, headers: corsHeaders });
    }

    const extension = filename.split(".").pop().toLowerCase();
    const contentType = mimeTypes[extension] || mimeTypes.default;

    return new Response(file.body, {
        headers: {
            ...corsHeaders,
            "Content-Type": contentType,
            "Content-Disposition": `inline; filename="${filename}"`,
        },
    });
}

export async function handlePutFile(request, env, ctx) {
    const url = new URL(request.url);
    let filePath = decodeURIComponent(url.pathname);

    if (filePath.includes("..") || filePath.trim() === "") {
        return new Response("Invalid path", { status: 400 });
    }

    filePath = filePath.replace(/^\/+/, ""); // Remove all leading slashes

    try {
        // Read the file data from the request body
        const data = await request.arrayBuffer();
        const extension = filePath.split(".").pop().toLowerCase();
        const contentType = mimeTypes[extension] || "application/octet-stream"; // Fallback MIME type

        // Upload the file to R2 with the given filePath as the key
        await env.MY_BUCKET.put(filePath, data, { httpMetadata: { contentType } });

        // Invalidate cache (ensure cache deletion works)
        const cache = caches.default;
        const listingUrl = new URL("/", request.url).toString();
        const cacheKey = new Request(listingUrl);
        ctx.waitUntil(cache.delete(cacheKey));

        return new Response("File uploaded successfully", { status: 200 });
    } catch (error) {
        console.error("Upload error:", error);
        return new Response("Failed to upload file", { status: 500 });
    }
}

export async function handleFileList(request, env, ctx) {
    // Handle directory listing (WebDAV-specific)
    const path = new URL(request.url).pathname;
    const prefix = path === "/" ? "" : path.slice(1); // Handle root path

    const bypassCache = true //request.headers.get("X-Bypass-Cache") === "true";
    const cache = caches.default;
    const cacheKey = new Request(request.url, { cf: { cacheTtl: 604800 } });

    if (!bypassCache) {
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) {
            console.log(`HIT`);
            return cachedResponse;
        }

    }
    console.log("MISS");
    // List objects in R2 with the correct prefix
    const objects = await env.MY_BUCKET.list({ prefix });
    console.log(objects);
    
    // Generate WebDAV XML response
    const xmlResponse = `
      <D:multistatus xmlns:D="DAV:">
        <D:response>
          <D:href>${path}</D:href>
          <D:propstat>
            <D:prop>
              <D:resourcetype><D:collection/></D:resourcetype>
              <D:displayname>${path === "/" ? "root" : path.split("/").pop()}</D:displayname>
            </D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
          </D:propstat>
        </D:response>
        ${objects.objects
            .map(
                (obj) => `
              <D:response>
                <D:href>/${encodeURIComponent(obj.key)}</D:href>
                <D:propstat>
                  <D:prop>
                    <D:resourcetype/> <!-- Empty for files -->
                    <D:getcontentlength>${obj.size}</D:getcontentlength>
                    <D:getlastmodified>${new Date(obj.uploaded).toUTCString()}</D:getlastmodified>
                  </D:prop>
                  <D:status>HTTP/1.1 200 OK</D:status>
                </D:propstat>
              </D:response>
            `
            )
            .join("")}
      </D:multistatus>
    `;

    const response = new Response(xmlResponse, {
        headers: {
            ...corsHeaders,
            "Content-Type": "application/xml",
         //   "Cache-Control": "public, max-age=604800"
        },
    });
  //  ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
}

// Multipart upload endpoints for files larger than the Workers 100MB per-request body limit.
// Maps onto the R2 multipart API: https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/

function sanitizeKey(rawKey) {
    if (!rawKey) return null;
    const key = decodeURIComponent(rawKey).replace(/^\/+/, "");
    if (!key || key.includes("..")) return null;
    return key;
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

export async function handleMultipartCreate(request, env) {
    const url = new URL(request.url);
    const key = sanitizeKey(url.searchParams.get("key"));
    if (!key) return jsonResponse({ error: "Invalid or missing key" }, 400);

    const extension = key.split(".").pop().toLowerCase();
    const contentType = mimeTypes[extension] || mimeTypes.default;

    try {
        const multipart = await env.MY_BUCKET.createMultipartUpload(key, {
            httpMetadata: { contentType },
        });
        return jsonResponse({ key, uploadId: multipart.uploadId });
    } catch (error) {
        console.error("multipart create error:", error);
        return jsonResponse({ error: "Failed to create multipart upload" }, 500);
    }
}

export async function handleMultipartUploadPart(request, env) {
    const url = new URL(request.url);
    const key = sanitizeKey(url.searchParams.get("key"));
    const uploadId = url.searchParams.get("uploadId");
    const partNumber = Number(url.searchParams.get("partNumber"));

    if (!key || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
        return jsonResponse({ error: "Invalid key/uploadId/partNumber" }, 400);
    }
    if (!request.body) return jsonResponse({ error: "Missing body" }, 400);

    try {
        const multipart = env.MY_BUCKET.resumeMultipartUpload(key, uploadId);
        const uploaded = await multipart.uploadPart(partNumber, request.body);
        return jsonResponse({ partNumber: uploaded.partNumber, etag: uploaded.etag });
    } catch (error) {
        console.error("multipart uploadPart error:", error);
        return jsonResponse({ error: "Failed to upload part" }, 500);
    }
}

export async function handleMultipartComplete(request, env, ctx) {
    const url = new URL(request.url);
    const key = sanitizeKey(url.searchParams.get("key"));
    const uploadId = url.searchParams.get("uploadId");

    if (!key || !uploadId) {
        return jsonResponse({ error: "Invalid key or uploadId" }, 400);
    }

    let parts;
    try {
        const body = await request.json();
        parts = body.parts;
    } catch {
        return jsonResponse({ error: "Body must be JSON: { parts: [...] }" }, 400);
    }
    if (!Array.isArray(parts) || parts.length === 0) {
        return jsonResponse({ error: "parts must be a non-empty array" }, 400);
    }

    try {
        const multipart = env.MY_BUCKET.resumeMultipartUpload(key, uploadId);
        await multipart.complete(parts);

        const cache = caches.default;
        const cacheKey = new Request(new URL("/", request.url).toString());
        ctx.waitUntil(cache.delete(cacheKey));

        return jsonResponse({ key, status: "success" });
    } catch (error) {
        console.error("multipart complete error:", error);
        return jsonResponse({ error: "Failed to complete multipart upload" }, 500);
    }
}

export async function handleMultipartAbort(request, env) {
    const url = new URL(request.url);
    const key = sanitizeKey(url.searchParams.get("key"));
    const uploadId = url.searchParams.get("uploadId");
    if (!key || !uploadId) {
        return jsonResponse({ error: "Invalid key or uploadId" }, 400);
    }
    try {
        const multipart = env.MY_BUCKET.resumeMultipartUpload(key, uploadId);
        await multipart.abort();
        return jsonResponse({ key, status: "aborted" });
    } catch (error) {
        console.error("multipart abort error:", error);
        return jsonResponse({ error: "Failed to abort multipart upload" }, 500);
    }
}

export async function dumpCache(request, env, ctx){
    const url = new URL(request.url);
    try {
        const listingUrl = new URL('/', url.origin).toString();
        const cache = caches.default;
        const cacheKey = new Request(listingUrl, { cf: { cacheTtl: 604800 } });
        ctx.waitUntil(cache.delete(cacheKey));
        return new Response('cache deleted successfully', { status: 200 });
    } catch (error) {
        console.log("error",error);
        
        return new Response('Failed to delete cache', { status: 500 });
    }
}
