// Cloudflare Worker: 黄果短剧 M3U 剧集展平版
const HOSTS = ["https://huangguoai.com", "https://ediayikma.cc"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 导出 M3U 标准直播列表
    if (path === "/live.m3u" || path === "/m3u") {
      return await handleM3uList(url);
    }

    // 播放节点: 动态解析指定集数的 m3u8 并 302 重定向
    if (path === "/play") {
      const vodId = url.searchParams.get("id");
      const ep = url.searchParams.get("ep") || "1";
      if (!vodId) return new Response("Missing id parameter", { status: 400 });
      return await handlePlayRedirect(vodId, ep);
    }

    return new Response(
      `黄果短剧 M3U 服务正常运行\n订阅地址: ${url.origin}/live.m3u`,
      { headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  }
};

/**
 * 分类配置 (自动展开每个分类下每部剧的所有集数)
 */
const CATEGORIES = [
  { name: "精选推荐", type: "page", slug: "recommend", pages: 2 },
  { name: "最近上新", type: "page", slug: "newest", pages: 2 },
  { name: "AI成人短剧", type: "api", slug: "ai-duanju", pages: 3 },
  { name: "AI成人漫剧", type: "api", slug: "ai-manju", pages: 3 },
  { name: "AI换脸", type: "api", slug: "ai-huanlian", pages: 3 },
  { name: "AI魔改", type: "api", slug: "ai-mogai", pages: 3 }
];

async function handleM3uList(currentUrl) {
  let m3uContent = `#EXTM3U name="黄果短剧全集展平源"\n`;

  const categoryPromises = CATEGORIES.map(cat => fetchFullCategoryData(cat));
  const results = await Promise.all(categoryPromises);

  for (let i = 0; i < CATEGORIES.length; i++) {
    const cat = CATEGORIES[i];
    const items = results[i];

    for (const item of items) {
      const totalEp = item.epCount > 0 ? item.epCount : 1;
      
      // 把这部剧的所有集数全部展平输出到 M3U 中
      for (let ep = 1; ep <= totalEp; ep++) {
        const epStr = ep < 10 ? `0${ep}` : `${ep}`;
        const channelName = `${item.title} 第${epStr}集`;
        const playUrl = `${currentUrl.origin}/play?id=${item.id}&ep=${ep}`;
        
        m3uContent += `#EXTINF:-1 tvg-id="${item.id}_${ep}" tvg-name="${channelName}" tvg-logo="${item.cover}" group-title="${cat.name}",${channelName}\n`;
        m3uContent += `${playUrl}\n`;
      }
    }
  }

  return new Response(m3uContent, {
    headers: {
      "Content-Type": "audio/x-mpegurl; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=1800"
    }
  });
}

/**
 * 抓取单分类数据
 */
async function fetchFullCategoryData(cat) {
  const pagePromises = [];
  for (let p = 1; p <= cat.pages; p++) {
    if (cat.type === "api") {
      pagePromises.push(fetchApiPage(cat.slug, p));
    } else {
      pagePromises.push(fetchHtmlPage(cat.slug, p));
    }
  }

  const pagesData = await Promise.all(pagePromises);
  const combined = pagesData.flat();

  const seen = new Set();
  return combined.filter(item => {
    if (!item.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/**
 * API 分类抓取（包含精准集数 episode_count）
 */
async function fetchApiPage(slug, page) {
  const url = `${HOSTS[0]}/api/videos/category/${slug}?sort=hot&page=${page}&size=24`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Referer": `${HOSTS[0]}/` } });
    if (!res.ok) return [];
    const data = await res.json();
    const items = data?.data?.items || [];
    return items.map(it => ({
      id: String(it.id),
      title: it.title ? it.title.trim() : "未命名",
      cover: it.cover || "",
      epCount: parseInt(it.episode_count || 1)
    }));
  } catch (e) {
    return [];
  }
}

/**
 * HTML 分类抓取（正则提取集数）
 */
async function fetchHtmlPage(slug, page) {
  const url = `${HOSTS[0]}/${slug}/${page}/`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Referer": `${HOSTS[0]}/` } });
    if (!res.ok) return [];
    const html = await res.text();

    const items = [];
    const blocks = html.split('<div class="hg-drama-card"');
    
    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i];
      const idMatch = block.match(/href="\/detail\/(\d+)\/?"/);
      if (!idMatch) continue;

      const id = idMatch[1];
      const titleMatch = block.match(/alt="([^"]+)"/) || block.match(/class="[^"]*hg-drama-card__title[^"]*"[^>]*>\s*<a[^>]*>(.*?)<\/a>/s);
      const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : "短剧";
      
      const imgMatch = block.match(/data-src="([^"]+)"/) || block.match(/src="([^"]+)"/);
      const cover = imgMatch ? imgMatch[1] : "";

      // 匹配“全21集”或“更新至15集”中的数字
      const epMatch = block.match(/class="hg-drama-card__episode">[^0-9]*(\d+)[^<]*</);
      const epCount = epMatch ? parseInt(epMatch[1]) : 1;

      items.push({ id, title, cover, epCount });
    }
    return items;
  } catch (e) {
    return [];
  }
}

/**
 * 实时 302 播放重定向 (支持针对指定集数 ep 请求)
 */
async function handlePlayRedirect(vodId, ep) {
  // 构建对应集数的路径
  const playPaths = [
    `/video/${vodId}/ep-${ep}/`,
    `/video/${vodId}/ep${ep}/`,
    `/video/${vodId}/p${ep}/`,
    `/video/${vodId}/`
  ];

  for (const path of playPaths) {
    const targetUrl = `${HOSTS[0]}${path}`;
    try {
      const res = await fetch(targetUrl, { headers: { "User-Agent": UA, "Referer": `${HOSTS[0]}/` } });
      if (!res.ok) continue;

      const html = await res.text();

      // 1. 从 JSON 数据提取对应集数的 m3u8
      const jsonMatch = html.match(/<script id="videoInitialData" type="application\/json">(.*?)<\/script>/s);
      if (jsonMatch && jsonMatch[1]) {
        try {
          const jsonData = JSON.parse(jsonMatch[1]);
          let m3u8Url = jsonData.videoSrc || jsonData.videoUrl || jsonData.playUrl || jsonData.src;
          
          if (!m3u8Url && jsonData.epPlaySrcs) {
            m3u8Url = jsonData.epPlaySrcs[ep] || jsonData.epPlaySrcs[String(ep)] || Object.values(jsonData.epPlaySrcs)[0];
          }
          if (m3u8Url) return Response.redirect(cleanUrl(m3u8Url), 302);
        } catch (e) {}
      }

      // 2. 从 HTML 属性正则匹配
      const srcMatch = html.match(/data-play-src="(https?:\/\/[^"]+)"/);
      if (srcMatch && srcMatch[1]) {
        return Response.redirect(cleanUrl(srcMatch[1]), 302);
      }
    } catch (e) {
      continue;
    }
  }

  return new Response("Stream Not Found", { status: 404 });
}

function cleanUrl(url) {
  if (!url) return "";
  let clean = url.replace(/\\u0026/g, "&").replace(/&amp;/g, "&").trim();
  return clean.startsWith("//") ? "https:" + clean : clean;
}
