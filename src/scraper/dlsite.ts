import * as cheerio from 'cheerio';
import { fetchHtml } from './client.js';

export interface DLsiteWorkInfo {
  id: string;
  title: string;
  circle: string;
  circleId: string;
  nsfw: boolean;
  releaseDate: string;
  dlCount: number;
  price: number;
  reviewCount: number;
  rateCount: number;
  rateAverage: number;
  tags: string[];
  vas: Array<{ id: string; name: string; }>;
  description: string;
  coverUrl: string;
}

export function extractRJId(input: string): string | null {
  const match = input.match(/([Rr][Jj])(\d+)/);
  if (match) {
    return `RJ${match[2]!.padStart(8, '0')}`;
  }
  return null;
}

export function getRJNumber(rjId: string): number {
  return parseInt(rjId.replace('RJ', ''), 10);
}

export async function fetchDLsiteWorkInfo(rjId: string): Promise<DLsiteWorkInfo> {
  const url = `https://www.dlsite.com/maniax/work/=/product_id/${rjId}.html`;

  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const title = $('#work_name').text().trim();
  const circle = $('.maker_name a').text().trim();
  const circleId = $('.maker_name a').attr('href')?.match(/maker_id=(\w+)/)?.[1] || '';
  const description = $('#work_outline').text().trim();

  // Extract tags
  const tags: string[] = [];
  $('a[href*="keyword"]').each((_, el) => {
    const tag = $(el).text().trim();
    if (tag) tags.push(tag);
  });

  // Extract VAs
  const vas: Array<{ id: string; name: string; }> = [];
  $('a[href*="voice_by"]').each((_, el) => {
    const name = $(el).text().trim();
    const href = $(el).attr('href') || '';
    const idMatch = href.match(/voice_by\/(\w+)/);
    if (name && idMatch?.[1]) {
      vas.push({ id: idMatch[1], name });
    }
  });

  // Extract other metadata
  const dlCount = parseInt($('#detail_download .count').text().replace(/,/g, '') || '0', 10);
  const priceText = $('.work_buy_content .price').text().replace(/[^\d]/g, '');
  const price = parseInt(priceText || '0', 10);
  const reviewCount = parseInt($('#review_count').text().replace(/,/g, '') || '0', 10);

  // Extract rating
  const rateAverage = parseFloat($('.star_rating').attr('data-rate') || '0');
  const rateCount = parseInt($('#review_count').text().replace(/,/g, '') || '0', 10);

  // Extract release date
  const releaseDateText = $('th:contains("販売日")').next('td').text().trim();
  const releaseDate = releaseDateText || '';

  // Extract cover URL
  const coverUrl = $('.slider_items img').first().attr('src') || '';

  return {
    id: rjId,
    title,
    circle,
    circleId,
    nsfw: true, // DLsite adult content
    releaseDate,
    dlCount,
    price,
    reviewCount,
    rateCount,
    rateAverage,
    tags,
    vas,
    description,
    coverUrl,
  };
}

export async function searchDLsite(keyword: string): Promise<DLsiteWorkInfo[]> {
  const url = `https://www.dlsite.com/maniax/fsr/=/keyword/${encodeURIComponent(keyword)}/`;

  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const works: DLsiteWorkInfo[] = [];

  $('.search_result_img_box').each((_, el) => {
    const href = $(el).find('a').attr('href') || '';
    const rjMatch = href.match(/product_id\/(RJ\d+)/);

    if (rjMatch?.[1]) {
      const rjId = rjMatch[1];
      const title = $(el).find('.work_name').text().trim();
      const circle = $(el).find('.maker_name').text().trim();

      works.push({
        id: rjId,
        title,
        circle,
        circleId: '',
        nsfw: true,
        releaseDate: '',
        dlCount: 0,
        price: 0,
        reviewCount: 0,
        rateCount: 0,
        rateAverage: 0,
        tags: [],
        vas: [],
        description: '',
        coverUrl: '',
      });
    }
  });

  return works;
}
