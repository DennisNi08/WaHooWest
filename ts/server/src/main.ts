import * as dotenv from "dotenv";
import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { Protocols, Message } from "../../shared/protocols";
import { Room } from "./room";

// Load .env from ts/server/.env
dotenv.config({ path: path.join(__dirname, "..", ".env") });

/**
 * WaHooWest game server – WebSocket version.
 *
 * Drop-in replacement for the Python TCP server.
 * Runs on ws://localhost:64210 by default.
 */
class Server {
  private wss: WebSocketServer;

  /** nickname per WebSocket */
  private clientNames = new Map<WebSocket, string>();
  /** opponent mapping (both directions stored) */
  private opponents = new Map<WebSocket, WebSocket>();
  /** room per WebSocket */
  private rooms = new Map<WebSocket, Room>();
  /** table preference per client */
  private clientTables = new Map<WebSocket, string>();
  /** per-subject waiting queue (subject → waiting client socket) */
  private waitingBySubject = new Map<WebSocket, string>(); // note: reversed for easy lookup too
  private waitingBySubjectMap = new Map<string, WebSocket>();

  constructor(private host = "0.0.0.0", private port = 64210) {
    this.wss = new WebSocketServer({ host, port });
    console.log(`Server listening on ws://${host}:${port}`);

    this.wss.on("connection", (ws) => {
      console.log(`[CONNECT] New WebSocket connection`);
      this.handleConnect(ws);
    });
  }

  /* ── Connection handling ──────────────────────────────── */

  private handleConnect(ws: WebSocket): void {
    // Step 1: Ask for nickname
    this.send(Protocols.Response.NICKNAME, null, ws);

    // The rest of the handshake happens in onMessage
    let phase: "waiting_nickname" | "waiting_table" | "playing" = "waiting_nickname";

    ws.on("message", (raw) => {
      let msg: Message;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.log("[ERROR] Failed to parse message");
        return;
      }

      if (phase === "waiting_nickname") {
        if (msg.type !== Protocols.Request.NICKNAME) return;
        this.clientNames.set(ws, msg.data);
        console.log(`[CONNECT] Nickname: ${msg.data}`);
        phase = "waiting_table";
        return;
      }

      if (phase === "waiting_table") {
        if (msg.type !== Protocols.Request.TABLE) return;
        const tableName: string = msg.data;
        this.clientTables.set(ws, tableName);
        console.log(`[CONNECT] Table: ${tableName}`);

        // Per-subject pairing
        const waitingClient = this.waitingBySubjectMap.get(tableName);
        if (waitingClient && waitingClient.readyState === WebSocket.OPEN) {
          this.waitingBySubjectMap.delete(tableName);
          this.waitingBySubject.delete(waitingClient);
          console.log(`[CONNECT] Pairing for ${tableName}`);
          this.createRoom(ws, waitingClient, tableName);
        } else {
          this.waitingBySubjectMap.set(tableName, ws);
          this.waitingBySubject.set(ws, tableName);
          console.log(`[CONNECT] Waiting for opponent in ${tableName}`);
        }
        phase = "playing";
        return;
      }

      // Phase: playing – handle game messages
      this.handleReceive(msg, ws);
    });

    ws.on("close", () => {
      console.log("[DISCONNECT] Client closed");
      this.sendToOpponent(Protocols.Response.OPPONENT_DISCONNECTED, null, ws);
      this.disconnect(ws);
    });

    ws.on("error", (err) => {
      console.log(`[ERROR] WebSocket error: ${err.message}`);
    });
  }

  /* ── Room creation ────────────────────────────────────── */

  private async createRoom(client: WebSocket, waitingClient: WebSocket, tableName: string): Promise<void> {
    console.log(`Creating Room for subject: ${tableName}`);
    const room = await Room.create(
      client,
      waitingClient,
      this.clientNames.get(client) ?? null,
      this.clientNames.get(waitingClient) ?? null,
      tableName
    );
    console.log(`Room created with ${room.questions.length} questions`);

    this.opponents.set(client, waitingClient);
    this.opponents.set(waitingClient, client);
    this.rooms.set(client, room);
    this.rooms.set(waitingClient, room);

    // Send opponent names
    this.send(Protocols.Response.OPPONENT, this.clientNames.get(client) ?? "???", waitingClient);
    this.send(Protocols.Response.OPPONENT, this.clientNames.get(waitingClient) ?? "???", client);

    // Send game data to each client
    for (const c of [client, waitingClient]) {
      this.send(Protocols.Response.QUESTIONS, room.questions, c);
      const detail = room.getCurrentQuestionDetail(c);
      if (detail) {
        this.send(Protocols.Response.QUESTION_DETAIL, detail, c);
      }
      // Small delay then START
      setTimeout(() => {
        this.send(Protocols.Response.START, null, c);
        console.log(`Sent START to client`);
      }, 500);
    }
  }

  /* ── Message handling ─────────────────────────────────── */

  private handleReceive(msg: Message, client: WebSocket): void {
    const { type: rType, data } = msg;
    const room = this.rooms.get(client);

    if (rType === Protocols.Request.TABLE) {
      this.clientTables.set(client, data);
      return;
    }

    if (rType !== Protocols.Request.ANSWER) return;
    if (!room) return;

    const correct = room.verifyAnswer(client, data);
    if (correct) {
      this.send(Protocols.Response.ANSWER_VALID, null, client);
    } else {
      this.send(Protocols.Response.ANSWER_INVALID, null, client);
    }

    this.sendToOpponent(Protocols.Response.OPPONENT_ADVANCE, null, client);

    if (room.isClientDone(client)) {
      this.send(Protocols.Response.GAME_OVER, room.getScore(client), client);

      if (room.areBothDone() && !room.finished) {
        room.finished = true;
        const { winner, loser } = room.getWinner();
        if (winner === null) {
          // Tie
          for (const c of room.indexes.keys()) {
            this.send(Protocols.Response.TIE, room.getScore(c), c);
          }
        } else {
          this.send(Protocols.Response.WINNER, null, winner);
          this.send(Protocols.Response.WINNER, this.clientNames.get(winner) ?? "???", loser!);
        }
      }
    } else {
      const detail = room.getCurrentQuestionDetail(client);
      if (detail) {
        this.send(Protocols.Response.QUESTION_DETAIL, detail, client);
      }
    }
  }

  /* ── Send helpers ─────────────────────────────────────── */

  private send(type: string, data: any, client: WebSocket): void {
    if (client.readyState !== WebSocket.OPEN) return;
    try {
      const json = JSON.stringify({ type, data });
      client.send(json);
      console.log(`[SEND] ${type} (${json.length} bytes)`);
    } catch (e: any) {
      console.log(`[ERROR] Send failed: ${e.message}`);
    }
  }

  private sendToOpponent(type: string, data: any, client: WebSocket): void {
    const opponent = this.opponents.get(client);
    if (!opponent) return;
    this.send(type, data, opponent);
  }

  /* ── Disconnect ───────────────────────────────────────── */

  private disconnect(client: WebSocket): void {
    const opponent = this.opponents.get(client);

    if (opponent) this.opponents.delete(opponent);
    this.opponents.delete(client);

    this.clientNames.delete(client);
    if (opponent) this.clientNames.delete(opponent);

    this.rooms.delete(client);
    if (opponent) this.rooms.delete(opponent);

    // Remove from waiting queues
    const subj = this.waitingBySubject.get(client);
    if (subj) {
      this.waitingBySubjectMap.delete(subj);
      this.waitingBySubject.delete(client);
    }

    this.clientTables.delete(client);

    try {
      client.close();
    } catch {
      /* already closed */
    }
  }
}

// ── Entry point ──────────────────────────────────────────
new Server();
