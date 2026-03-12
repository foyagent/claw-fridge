import { NextRequest, NextResponse } from "next/server";

/**
 * Git 透明代理
 * 解决浏览器 CORS 问题：前端 → /api/git/proxy → Git 服务器
 */

export async function GET() {
  return NextResponse.json({
    message: "Git Proxy API",
    usage: "POST with { url, method, headers, body }",
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, method, headers, body: requestBody } = body;

    if (!url) {
      return NextResponse.json({ error: "Missing url" }, { status: 400 });
    }

    // 过滤并转发必要的 headers（包括 Authorization）
    const forwardHeaders: Record<string, string> = {};
    if (headers && typeof headers === "object") {
      // 转发 Git 相关的 headers
      for (const [key, value] of Object.entries(headers)) {
        const lowerKey = key.toLowerCase();
        // 只转发必要的 headers
        if (
          [
            "authorization",
            "content-type",
            "accept",
            "user-agent",
            "git-protocol",
          ].includes(lowerKey) &&
          typeof value === "string"
        ) {
          forwardHeaders[key] = value;
        }
      }
    }

    // 转发请求到目标 Git 服务器
    const fetchOptions: RequestInit = {
      method: method || "GET",
      headers: forwardHeaders,
    };

    if (requestBody) {
      fetchOptions.body = Buffer.from(requestBody, "base64");
    }

    const response = await fetch(url, fetchOptions);

    // 返回响应
    const responseHeaders = new Headers();
    
    // 复制必要的响应头
    response.headers.forEach((value, key) => {
      // 避免复制可能导致问题的 headers
      if (!["content-encoding", "transfer-encoding", "connection"].includes(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });

    const responseBody = await response.arrayBuffer();

    return new NextResponse(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("Git proxy error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Proxy error" },
      { status: 500 }
    );
  }
}
