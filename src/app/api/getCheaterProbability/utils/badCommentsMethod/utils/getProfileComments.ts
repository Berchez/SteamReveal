import { steamCommentType } from '@/@types/steamCommentType';
import axios from 'axios';
import * as cheerio from 'cheerio';

const getProfileComments = async (target: string) => {
  const url = `https://steamcommunity.com/comment/Profile/render/${target}/?start=0&count=200`;
  const response = await axios.get(url);
  const html = response.data.comments_html;
  const $ = cheerio.load(html);

  const comments: steamCommentType[] = [];
  $('.commentthread_comment').each((_, el) => {
    comments.push({
      author: $(el).find('.commentthread_comment_author a').text().trim(),
      text: $(el).find('.commentthread_comment_text').text().trim(),
    });
  });

  return comments;
};

export default getProfileComments;
