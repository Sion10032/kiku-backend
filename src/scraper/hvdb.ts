import * as cheerio from 'cheerio';
import { fetchHtml } from './client.js';

export interface HVDBWorkInfo {
  id: string;
  title: string;
  circle: string;
  releaseDate: string;
  tags: string[];
  vas: Array<{ id: string; name: string; }>;
  description: string;
}

export async function fetchHVDBWorkInfo(rjId: string): Promise<HVDBWorkInfo | null> {
  const url = `https://hvdb.me/Dashboard/WorkDetails/${rjId}`;

  try {
    const html = await fetchHtml(url, {
      headers: {
        Referer: 'https://hvdb.me/',
      },
    });

    const $ = cheerio.load(html);

    const title = $('h2.panel-title').text().trim();
    const circle = $('a[href*="Circle"]').text().trim();
    const description = $('.panel-body p').first().text().trim();

    // Extract tags
    const tags: string[] = [];
    $('a[href*="Tag"]').each((_, el) => {
      const tag = $(el).text().trim();
      if (tag) tags.push(tag);
    });

    // Extract VAs
    const vas: Array<{ id: string; name: string; }> = [];
    $('a[href*="VA"]').each((_, el) => {
      const name = $(el).text().trim();
      const href = $(el).attr('href') || '';
      const idMatch = href.match(/VA\/(\d+)/);
      if (name && idMatch?.[1]) {
        vas.push({ id: idMatch[1], name });
      }
    });

    // Extract release date
    const releaseDateText = $('td:contains("Release Date")').next('td').text().trim();
    const releaseDate = releaseDateText || '';

    return {
      id: rjId,
      title,
      circle,
      releaseDate,
      tags,
      vas,
      description,
    };
  }
  catch {
    // HVDB might not have this work
    return null;
  }
}

export async function searchHVDB(keyword: string): Promise<HVDBWorkInfo[]> {
  const url = `https://hvdb.me/Dashboard/Search?keyword=${encodeURIComponent(keyword)}`;

  try {
    const html = await fetchHtml(url, {
      headers: {
        Referer: 'https://hvdb.me/',
      },
    });

    const $ = cheerio.load(html);
    const works: HVDBWorkInfo[] = [];

    $('tr.work-row').each((_, el) => {
      const title = $(el).find('td').eq(1).text().trim();
      const circle = $(el).find('td').eq(2).text().trim();
      const href = $(el).find('a').attr('href') || '';
      const idMatch = href.match(/WorkDetails\/(RJ\d+)/);

      if (idMatch?.[1] && title) {
        works.push({
          id: idMatch[1],
          title,
          circle,
          releaseDate: '',
          tags: [],
          vas: [],
          description: '',
        });
      }
    });

    return works;
  }
  catch {
    return [];
  }
}
