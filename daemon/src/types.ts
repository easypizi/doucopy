export type AskMode = "ask" | "discuss";

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
