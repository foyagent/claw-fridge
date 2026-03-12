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

    // 转发请求到目标 Git 服务器
    const fetchOptions: RequestInit = {
      method: method || "GET",
      headers: headers || {},
    };

    if (requestBody) {
      fetchOptions.body = Buffer.from(requestBody, "base64");
    }

    const response = await fetch(url, fetchOptions);

    // 返回响应
    const responseHeaders = new Headers();
    
    // 复制必要的响应头
    response.headers.forEach((value, key) => {
      responseHeaders.set(key, value);
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
