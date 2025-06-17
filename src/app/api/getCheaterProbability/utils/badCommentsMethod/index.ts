import badWordsArr from './utils/badWords';
import getProfileComments from './utils/getProfileComments';

const getBadCommentsScore = async (target: string): Promise<number> => {
  const allComments = await getProfileComments(target);
  const allCommentsText = allComments.map((comment) => comment.text);

  const totalScore = allCommentsText.reduce((total, comment) => {
    const normalized = comment.toLowerCase();

    const commentScore = badWordsArr.reduce((score, word) => {
      const matches = normalized.match(new RegExp(`\\b${word}\\b`, 'g'));
      return score + (matches ? matches.length : 0);
    }, 0);

    return total + commentScore;
  }, 0);

  return totalScore;
};

export default getBadCommentsScore;
