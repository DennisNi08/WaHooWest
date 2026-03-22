/** Protocol message types shared between server and client */
export const Protocols = {
  Response: {
    NICKNAME: "protocols.response.nickname",
    QUESTIONS: "protocols.questions",
    QUESTION_DETAIL: "protocols.question.detail",
    START: "protocols.start",
    OPPONENT: "protocols.opponent",
    OPPONENT_ADVANCE: "protocols.opponent.advance",
    ANSWER_VALID: "protocols.answer.valid",
    ANSWER_INVALID: "protocols.answer.invalid",
    WINNER: "protocols.winner",
    TIE: "protocols.tie",
    GAME_OVER: "protocols.game.over",
    OPPONENT_DISCONNECTED: "protocols.opponent.disconnected",
  },
  Request: {
    ANSWER: "protocols.answer",
    NICKNAME: "protocols.nickname",
    TABLE: "protocols.table",
    LEAVE: "protocols.leave",
  },
} as const;

export interface Message {
  type: string;
  data: any;
}

export interface QuestionDetail {
  question: string;
  answer: string;
  choices: { A: string | null; B: string | null; C: string | null; D: string | null };
  image_url: string | null;
  image_data: string | null;   // base64 PNG
  passage: string | null;
}
