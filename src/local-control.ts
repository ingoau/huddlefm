export function controlDenied(request: Request, token?: string) {
  if (!token) return new Response("Not found", { status: 404 });
  if (request.headers.get("authorization") !== `Bearer ${token}`)
    return new Response("Unauthorized", { status: 401 });
}
