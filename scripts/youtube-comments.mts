// Fetch YouTube comments for a video without loading the watch page (no
// browser, no player, no autoplay). Uses the public innertube web endpoint.
// Usage: npx tsx scripts/youtube-comments.mts <videoId> [maxPages]
const videoId = process.argv[2];
const maxPages = Number(process.argv[3] ?? 5);
if (!videoId) {
  console.error("usage: npx tsx scripts/youtube-comments.mts <videoId> [maxPages]");
  process.exit(1);
}

const ENDPOINT = "https://www.youtube.com/youtubei/v1/next";
const context = {
  client: { clientName: "WEB", clientVersion: "2.20250101.00.00", hl: "en", gl: "US" },
};

interface CommentPayload {
  author?: { displayName?: string };
  properties?: { content?: { content?: string }; publishedTime?: string; commentId?: string };
}

interface InnertubeResponse {
  frameworkUpdates?: {
    entityBatchUpdate?: {
      mutations?: { payload?: { commentEntityPayload?: CommentPayload } }[];
    };
  };
}

async function call(body: object): Promise<InnertubeResponse> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context, ...body }),
  });
  if (!res.ok) throw new Error(`innertube ${res.status}`);
  return (await res.json()) as InnertubeResponse;
}

function findCommentToken(json: InnertubeResponse): string | null {
  const s = JSON.stringify(json);
  const m =
    /"sectionIdentifier":"comment-item-section".{0,2000}?"token":"([^"]+)"/.exec(s) ??
    /"targetId":"engagement-panel-comments-section".{0,3000}?"token":"([^"]+)"/.exec(s);
  return m ? m[1] : null;
}

const watch = await call({ videoId });
let token = findCommentToken(watch);
if (!token) {
  console.error("no comment continuation token found (comments disabled or layout changed)");
  process.exit(2);
}

interface Comment {
  author: string;
  published: string;
  text: string;
  id: string;
}
const comments: Comment[] = [];
for (let page = 0; token && page < maxPages; page++) {
  const j = await call({ continuation: token });
  const mutations = j.frameworkUpdates?.entityBatchUpdate?.mutations ?? [];
  for (const mu of mutations) {
    const p = mu.payload?.commentEntityPayload;
    if (!p) continue;
    comments.push({
      author: p.author?.displayName ?? "?",
      published: p.properties?.publishedTime ?? "?",
      text: p.properties?.content?.content ?? "",
      id: p.properties?.commentId ?? "",
    });
  }
  const nt = /"continuationCommand":\{"token":"([^"]+)","request":"CONTINUATION_REQUEST_TYPE_NEXT/.exec(
    JSON.stringify(j),
  );
  token = nt ? nt[1] : null;
}

console.log(`${comments.length} comment(s) for ${videoId}`);
for (const c of comments) {
  console.log(`--- ${c.author} · ${c.published} · ${c.id}`);
  console.log(c.text);
}
