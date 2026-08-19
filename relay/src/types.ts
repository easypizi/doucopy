export type AskMode = "ask" | "discuss";

/** UTF-8 text file attached by the asker for the responder workspace. */
export interface Attachment {
  name: string;
  content: string;
}

export interface Question {
  ticket_id: string;
  from_peer: string;
  question: string;
  conversation_id: string;
  hops: number;
  created_at: number;
  deadline: number;
  mode?: AskMode;
  brief?: string;
  attachments?: Attachment[];
}
