import * as dotenv from "dotenv";
import * as path from "path";
import * as http from "http";
import * as fs from "fs";
import { WebSocketServer, WebSocket } from "ws";
import { Protocols, Message } from "../../shared/protocols";
import { Room } from "./room";

// Load .env – try multiple likely paths
const envCandidates = [
  path.join(__dirname, "..", ".env"),                    // dev: ts/server/src/../.env
  path.join(__dirname, "..", "..", ".env"),              // alt
  path.join(__dirname, "..", "..", "..", "..", "server", ".env"),  // compiled: dist/server/server/src/../../../../server/.env
  path.resolve("server", ".env"),                       // cwd-relative
];
for (const p of envCandidates) {
  const result = dotenv.config({ path: p });
  if (!result.error) {
    console.log(`[ENV] Loaded .env from ${p}`);
    break;
  }
}

/**
 * WaHooWest game server – WebSocket version.
 *
 * Drop-in replacement for the Python TCP server.
 * Runs on ws://localhost:64210 by default.
 */
class Server {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private clientDir: string;

  /** nickname per WebSocket */
  private clientNames = new Map<WebSocket, string>();
  /** opponent mapping (both directions stored) */
  private opponents = new Map<WebSocket, WebSocket>();
  /** room per WebSocket */
  private rooms = new Map<WebSocket, Room>();
  /** table preference per client */
  private clientTables = new Map<WebSocket, string>();
  /** species per client */
  private clientSpecies = new Map<WebSocket, string>();
  /** per-subject waiting queue (subject → waiting client socket) */
  private waitingBySubject = new Map<WebSocket, string>(); // note: reversed for easy lookup too
  private waitingBySubjectMap = new Map<string, WebSocket>();

  constructor(private host = "0.0.0.0", private port = 64210) {
    // Resolve client directory - works in both dev (ts-node) and prod (compiled JS)
    // Try multiple possible paths since the exact __dirname varies by execution context
    const possiblePaths = [
      path.join(__dirname, "..", "..", "client", "src"),  // ts-node: server/src -> client/src
      path.join(__dirname, "..", "..", "..", "..", "client", "src"),  // compiled: dist/server/server/src -> client/src
      path.resolve("client", "src"),  // relative to cwd
    ];
    
    this.clientDir = possiblePaths.find(p => fs.existsSync(p)) || possiblePaths[0];
    console.log(`Using client directory: ${this.clientDir}`);

    // Create HTTP server
    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    // Attach WebSocket server to HTTP server
    this.wss = new WebSocketServer({ server: this.httpServer });
    console.log(`Server listening on http://${host}:${port}`);

    this.wss.on("connection", (ws) => {
      console.log(`[CONNECT] New WebSocket connection`);
      this.handleConnect(ws);
    });

    this.httpServer.listen(this.port, this.host);
  }

  /* ── HTTP request handling ──────────────────────────────── */

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Parse URL and get pathname only (remove query strings)
    const url = req.url || "/";
    const pathname = url.split("?")[0];
    
    // Normalize the path: remove leading slash and default to index.html
    let requestPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    
    // Build full file path
    const filePath = path.normalize(path.join(this.clientDir, requestPath));
    
    // Security: ensure resolved path is within clientDir
    const normalizedClientDir = path.normalize(this.clientDir);
    if (!filePath.startsWith(normalizedClientDir)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      console.log(`[HTTP] 403: ${pathname} (path traversal attempt)`);
      return;
    }

    // Try to read and serve the file
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        console.log(`[HTTP] 404: ${pathname} (file not found at ${filePath})`);
        return;
      }

      // Determine content type
      const ext = path.extname(filePath).toLowerCase();
      let contentType = "text/plain";
      if (ext === ".html") contentType = "text/html";
      else if (ext === ".css") contentType = "text/css";
      else if (ext === ".js") contentType = "application/javascript";
      else if (ext === ".json") contentType = "application/json";
      else if (ext === ".png") contentType = "image/png";
      else if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
      else if (ext === ".gif") contentType = "image/gif";
      else if (ext === ".svg") contentType = "image/svg+xml";

      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
      console.log(`[HTTP] 200: ${pathname}`);
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

    // Send opponent info (name + species)
    this.send(Protocols.Response.OPPONENT, {
      name: this.clientNames.get(client) ?? "???",
      species: this.clientSpecies.get(client) ?? "dino",
    }, waitingClient);
    this.send(Protocols.Response.OPPONENT, {
      name: this.clientNames.get(waitingClient) ?? "???",
      species: this.clientSpecies.get(waitingClient) ?? "dino",
    }, client);

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

      // Clean up old room/opponent so this client can re-queue
      const oldOpponent = this.opponents.get(client);
      if (oldOpponent) {
        this.opponents.delete(oldOpponent);
        this.rooms.delete(oldOpponent);
      }
      this.opponents.delete(client);
      this.rooms.delete(client);

      // Remove from any previous waiting queue
      const prevSubj = this.waitingBySubject.get(client);
      if (prevSubj) {
        this.waitingBySubjectMap.delete(prevSubj);
        this.waitingBySubject.delete(client);
      }

      // Per-subject pairing (same logic as initial connect)
      const tableName: string = data;
      const waitingClient = this.waitingBySubjectMap.get(tableName);
      if (waitingClient && waitingClient !== client && waitingClient.readyState === WebSocket.OPEN) {
        this.waitingBySubjectMap.delete(tableName);
        this.waitingBySubject.delete(waitingClient);
        console.log(`[REPLAY] Pairing for ${tableName}`);
        this.createRoom(client, waitingClient, tableName);
      } else {
        this.waitingBySubjectMap.set(tableName, client);
        this.waitingBySubject.set(client, tableName);
        console.log(`[REPLAY] Waiting for opponent in ${tableName}`);
      }
      return;
    }

    if (rType === Protocols.Request.SPECIES) {
      this.clientSpecies.set(client, data);
      return;
    }

    if (rType === Protocols.Request.FEEDBACK) {
      this.handleFeedbackRequest(data, client);
      return;
    }

    if (rType !== Protocols.Request.ANSWER) return;
    if (!room) return;

    const correct = room.verifyAnswer(client, data);
    // Build review item for the just-answered question (index already incremented)
    const answeredIdx = (room.indexes.get(client) ?? 1) - 1;
    const ch = room.choiceOptions[answeredIdx] ?? [null, null, null, null];
    const reviewItem = {
      question: room.questions[answeredIdx] ?? "",
      correctAnswer: room.answers[answeredIdx] ?? "",
      yourAnswer: data,
      choices: { A: ch[0], B: ch[1], C: ch[2], D: ch[3] },
    };
    if (correct) {
      this.send(Protocols.Response.ANSWER_VALID, reviewItem, client);
    } else {
      this.send(Protocols.Response.ANSWER_INVALID, reviewItem, client);
    }

    this.sendToOpponent(Protocols.Response.OPPONENT_ADVANCE, correct, client);

    // Check for early win: first to WIN_TARGET correct
    const earlyResult = room.hasEarlyWinner();
    if (earlyResult.winner && !room.finished) {
      room.finished = true;
      const opponent = this.opponents.get(client);
      // Send GAME_OVER to both
      this.send(Protocols.Response.GAME_OVER, room.getScore(client), client);
      if (opponent) this.send(Protocols.Response.GAME_OVER, room.getScore(opponent), opponent);
      // Send WINNER
      this.send(Protocols.Response.WINNER, null, earlyResult.winner);
      this.send(Protocols.Response.WINNER, this.clientNames.get(earlyResult.winner) ?? "???", earlyResult.loser!);
    } else if (room.isClientDone(client)) {
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

  /* ── Gemini AI Feedback ───────────────────────────────── */

  private async handleFeedbackRequest(reviewData: any[], client: WebSocket): Promise<void> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.log("[AI] No GEMINI_API_KEY set, skipping feedback");
      this.send(Protocols.Response.AI_FEEDBACK, "AI feedback is not configured.", client);
      return;
    }

    // Build a summary of the player's performance
    const lines = reviewData.map((item: any, i: number) => {
      const status = item.correct ? "CORRECT" : "WRONG";
      const q = item.question || "(no text)";
      const yourAns = item.yourAnswer || "?";
      const correctAns = item.correctAnswer || "?";
      return `Q${i + 1} [${status}]: "${q.slice(0, 200)}" — You answered: ${yourAns}, Correct: ${correctAns}`;
    });

    const correct = reviewData.filter((r: any) => r.correct).length;
    const total = reviewData.length;

    const prompt = `You are an expert academic tutor and quiz coach for a competitive study game called WaHooWest. A player just completed a round. Analyze their performance in depth.

Results: ${correct}/${total} correct

${lines.join("\n")}

Provide a thorough, structured analysis following this format:

1. PERFORMANCE SUMMARY: Give an overall assessment of how they did. Be specific about their score and what it means.

2. WHAT YOU NAILED: For each question they got right, briefly explain why that answer is correct and praise their knowledge.

3. WHERE YOU STUMBLED: For each wrong answer, explain:
   - Why their chosen answer is incorrect
   - Why the correct answer is right
   - The key concept or reasoning they may have missed

4. STUDY TIPS: Based on the specific topics they struggled with, give 2-3 actionable study strategies. Be specific to the subject matter, not generic advice.

5. ENCOURAGEMENT: End with a motivating note about their progress and potential.

Keep a warm, encouraging tone throughout — like a supportive coach, not a harsh grader. Use plain text only, NO markdown formatting (no asterisks, no hashtags, no bullet symbols). Use numbered lists and line breaks for structure instead.`;

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
      const body = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 800,
        },
      });

      console.log(`[AI] Requesting Gemini feedback for ${total} questions...`);
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.log(`[AI] Gemini API error ${resp.status}: ${errText.slice(0, 200)}`);
        
        // Provide a robust fallback if AI is ratelimited (429) or fails
        const fallbackText = `Wow, great effort! You scored ${correct} out of ${total}.\n\n` +
          `Tip: Always read the passage carefully and look for evidence that directly supports your answer.\n\n` +
          `Keep practicing to improve your speed and accuracy!`;
          
        this.send(Protocols.Response.AI_FEEDBACK, fallbackText, client);
        return;
      }

      const json: any = await resp.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "No feedback generated.";
      console.log(`[AI] Feedback received (${text.length} chars)`);
      this.send(Protocols.Response.AI_FEEDBACK, text, client);
    } catch (e: any) {
      console.log(`[AI] Fetch error: ${e.message}`);
      this.send(Protocols.Response.AI_FEEDBACK, "Could not generate feedback right now.", client);
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
    this.clientSpecies.delete(client);

    try {
      client.close();
    } catch {
      /* already closed */
    }
  }
}

// ── Entry point ──────────────────────────────────────────
new Server();
