export interface Question {
  ticket_id: string;
  from_peer: string;
  question: string;
  conversation_id: string;
  created_at: number;
  deadline: number;
}
