import { WebSocket } from "ws";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { QuestionDetail } from "../../shared/protocols";

// Snowflake SDK (lazy-loaded)
let snowflake: any = null;
try {
  snowflake = require("snowflake-sdk");
} catch {
  console.log("[ROOM] snowflake-sdk not available");
}

type ChoiceTuple = [string | null, string | null, string | null, string | null];

/**
 * Room manages a quiz session between two connected clients.
 *
 * Loads questions from Snowflake (read-only). Falls back to
 * a small in-memory question set when Snowflake is unavailable.
 */
export class Room {
  static MAX_QUESTIONS = 3;

  questions: string[] = [];
  answers: string[] = [];
  choiceOptions: ChoiceTuple[] = [];
  imageNames: (string | null)[] = [];
  passages: (string | null)[] = [];

  indexes: Map<WebSocket, number> = new Map();
  correctCounts: Map<WebSocket, number> = new Map();
  finished = false;

  clientMap: Map<WebSocket, string> = new Map();
  nickMap: Map<string, string | null> = new Map();

  imageCache: Map<string, string> = new Map(); // lowercase filename → base64
  createdAt: number;

  constructor(
    public client1: WebSocket,
    public client2: WebSocket,
    public nickname1: string | null = null,
    public nickname2: string | null = null,
    public tableName: string | null = null
  ) {
    this.createdAt = Date.now();
    this.indexes.set(client1, 0);
    this.indexes.set(client2, 0);
    this.correctCounts.set(client1, 0);
    this.correctCounts.set(client2, 0);

    this.clientMap.set(client1, "client1");
    this.clientMap.set(client2, "client2");
    this.nickMap.set("client1", nickname1);
    this.nickMap.set("client2", nickname2);
  }

  /** Async factory: loads questions + images before returning the room */
  static async create(
    client1: WebSocket,
    client2: WebSocket,
    nickname1: string | null,
    nickname2: string | null,
    tableName: string | null
  ): Promise<Room> {
    const room = new Room(client1, client2, nickname1, nickname2, tableName);
    console.log(`[ROOM] Initializing room with table=${tableName}, n1=${nickname1}, n2=${nickname2}`);

    const loaded = await room.loadQuestionsFromSnowflake(tableName);
    if (loaded) {
      room.questions = loaded.questions;
      room.answers = loaded.answers;
      room.choiceOptions = loaded.choices;
      room.imageNames = loaded.imageNames;
      room.passages = loaded.passages;
      console.log(`[ROOM] Loaded ${room.questions.length} questions from Snowflake`);
    } else {
      console.log("[ROOM] Using fallback questions");
      const fb = room.generateFallback();
      room.questions = fb.questions;
      room.answers = fb.answers;
    }

    // Shuffle & limit
    if (room.questions.length > Room.MAX_QUESTIONS) {
      const indices = Array.from({ length: room.questions.length }, (_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      const pick = indices.slice(0, Room.MAX_QUESTIONS);
      room.questions = pick.map((i) => room.questions[i]);
      room.answers = pick.map((i) => room.answers[i]);
      room.choiceOptions = pick.map((i) => room.choiceOptions[i] ?? [null, null, null, null]);
      room.imageNames = pick.map((i) => room.imageNames[i] ?? null);
      room.passages = pick.map((i) => room.passages[i] ?? null);
      console.log(`[ROOM] Shuffled to ${room.questions.length} questions`);
    }

    await room.downloadImages();
    return room;
  }

  /* ── Question helpers ──────────────────────────────────── */

  generateFallback() {
    return {
      questions: ["What is 2 + 2?", "What is 5 * 3?", "What is 10 - 4?", "What is 12 / 3?", "What is 7 + 8?"],
      answers: ["4", "15", "6", "4", "15"],
    };
  }

  verifyAnswer(client: WebSocket, attempt: string): boolean {
    if (this.finished) return false;
    const index = this.indexes.get(client);
    if (index === undefined) return false;
    if (index >= this.answers.length || index >= Room.MAX_QUESTIONS) return false;

    const correct =
      String(this.answers[index]).trim().toUpperCase() === String(attempt).trim().toUpperCase();

    if (correct) {
      this.correctCounts.set(client, (this.correctCounts.get(client) ?? 0) + 1);
    }
    this.indexes.set(client, index + 1);
    return correct;
  }

  isClientDone(client: WebSocket): boolean {
    const idx = this.indexes.get(client) ?? 0;
    return idx >= Math.min(this.questions.length, Room.MAX_QUESTIONS);
  }

  areBothDone(): boolean {
    for (const c of this.indexes.keys()) {
      if (!this.isClientDone(c)) return false;
    }
    return true;
  }

  getWinner(): { winner: WebSocket | null; loser: WebSocket | null } {
    const clients = [...this.indexes.keys()];
    if (clients.length < 2) return { winner: null, loser: null };
    const [c1, c2] = clients;
    const s1 = this.correctCounts.get(c1) ?? 0;
    const s2 = this.correctCounts.get(c2) ?? 0;
    if (s1 > s2) return { winner: c1, loser: c2 };
    if (s2 > s1) return { winner: c2, loser: c1 };
    return { winner: null, loser: null }; // tie
  }

  getScore(client: WebSocket): number {
    return this.correctCounts.get(client) ?? 0;
  }

  getCurrentQuestionDetail(client: WebSocket): QuestionDetail | null {
    const index = this.indexes.get(client);
    if (index === undefined || index >= this.questions.length || index >= Room.MAX_QUESTIONS) return null;

    const imageName = this.imageNames[index] ?? null;
    let imageData: string | null = null;
    let imageUrl: string | null = null;
    if (imageName) {
      imageUrl = `@WAHOOWEST.PUBLIC.QUESTIONS_IMG/${imageName}`;
      imageData = this.imageCache.get(imageName.toLowerCase()) ?? null;
    }

    const c = this.choiceOptions[index] ?? [null, null, null, null];
    return {
      question: this.questions[index],
      answer: this.answers[index],
      choices: { A: c[0], B: c[1], C: c[2], D: c[3] },
      image_url: imageUrl,
      image_data: imageData,
      passage: this.passages[index] ?? null,
    };
  }

  /* ── Snowflake ─────────────────────────────────────────── */

  private getSnowflakeConnection(): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!snowflake) return reject(new Error("snowflake-sdk not installed"));
      const conn = snowflake.createConnection({
        account: process.env.SNOW_ACCOUNT ?? "",
        username: process.env.SNOW_USER ?? "",
        password: process.env.SNOW_PASSWORD ?? "",
        warehouse: process.env.SNOW_WAREHOUSE,
        database: process.env.SNOW_DATABASE,
        schema: process.env.SNOW_SCHEMA,
        region: process.env.SNOW_REGION,
      });
      conn.connect((err: Error | null) => {
        if (err) return reject(err);
        resolve(conn);
      });
    });
  }

  private execSql(conn: any, sql: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
      conn.execute({
        sqlText: sql,
        complete: (err: Error | null, _stmt: any, rows: any[]) => {
          if (err) return reject(err);
          resolve(rows ?? []);
        },
      });
    });
  }

  async loadQuestionsFromSnowflake(
    tableOverride: string | null
  ): Promise<{
    questions: string[];
    answers: string[];
    choices: ChoiceTuple[];
    imageNames: (string | null)[];
    passages: (string | null)[];
  } | null> {
    const database = process.env.SNOW_DATABASE ?? "WAHOOWEST";
    const schema = process.env.SNOW_SCHEMA ?? "PUBLIC";
    let tables: string[];

    if (tableOverride) {
      tables = tableOverride
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => (t.includes(".") ? t : `${database}.${schema}.${t}`));
    } else {
      const envTables = process.env.SNOW_TABLES ?? process.env.SNOW_TABLE;
      if (!envTables) return null;
      tables = envTables
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }

    if (!process.env.SNOW_PASSWORD) return null;

    let conn: any;
    try {
      conn = await this.getSnowflakeConnection();
    } catch (e: any) {
      console.log(`[ROOM] Snowflake connection failed: ${e.message}`);
      return null;
    }

    const questions: string[] = [];
    const answers: string[] = [];
    const choices: ChoiceTuple[] = [];
    const imageNames: (string | null)[] = [];
    const passages: (string | null)[] = [];

    try {
      for (const tbl of tables) {
        const sql = `SELECT QS, ANSWER, CHOICEA, CHOICEB, CHOICEC, CHOICED, IMAGE_NAME, PASSAGE FROM ${tbl} LIMIT 200`;
        let rows: any[];
        try {
          rows = await this.execSql(conn, sql);
          console.log(`Loaded ${rows.length} rows from ${tbl}`);
        } catch (e: any) {
          console.log(`Error loading ${tbl}: ${e.message}`);
          continue;
        }

        for (const r of rows) {
          const qs = r.QS ?? r.qs ?? null;
          const ans = r.ANSWER ?? r.answer ?? null;
          const a = r.CHOICEA ?? r.choicea ?? null;
          const b = r.CHOICEB ?? r.choiceb ?? null;
          const c = r.CHOICEC ?? r.choicec ?? null;
          const d = r.CHOICED ?? r.choiced ?? null;
          let img = r.IMAGE_NAME ?? r.image_name ?? null;
          const passage = r.PASSAGE ?? r.passage ?? null;

          if (ans && String(ans).trim().toUpperCase() === "ANSWER") continue;
          if (img && String(img).trim().toUpperCase() === "IMAGE_NAME") img = null;
          if (!ans) continue;
          if (!qs && !img) continue;

          const qsStr = qs ? String(qs) : "(See image)";
          console.log(`[DB] ${qsStr.slice(0, 60)}... | Answer: ${ans} | Image: ${img}`);
          questions.push(qsStr);
          answers.push(String(ans));
          choices.push([a, b, c, d]);
          imageNames.push(img);
          passages.push(passage);
        }
      }
    } finally {
      conn.destroy(() => {});
    }

    if (questions.length === 0) return null;
    console.log(`Successfully loaded ${questions.length} total questions`);
    return { questions, answers, choices, imageNames, passages };
  }

  async downloadImages(): Promise<void> {
    const needed = new Set<string>();
    for (const img of this.imageNames) {
      if (img && img.trim() && img.toUpperCase() !== "IMAGE_NAME") {
        needed.add(img.trim());
      }
    }
    if (needed.size === 0) {
      console.log("[ROOM] No images to download");
      return;
    }

    if (!snowflake || !process.env.SNOW_PASSWORD) return;
    console.log(`[ROOM] Downloading ${needed.size} images...`);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wahoo_img_"));
    let conn: any;
    try {
      conn = await this.getSnowflakeConnection();
    } catch {
      return;
    }

    try {
      // LIST stage files
      const stageFiles = new Map<string, string>(); // lowercase → actual name
      const listRows = await this.execSql(conn, "LIST @WAHOOWEST.PUBLIC.QUESTIONS_IMG");
      for (const row of listRows) {
        const fullPath: string = row.name ?? row.NAME ?? "";
        const base = path.basename(fullPath);
        stageFiles.set(base.toLowerCase(), base);
      }
      console.log(`[ROOM] Stage has ${stageFiles.size} files`);

      for (const imgName of needed) {
        const actual = stageFiles.get(imgName.toLowerCase());
        if (!actual) {
          console.log(`[ROOM] Image ${imgName} not found in stage`);
          continue;
        }

        try {
          await this.execSql(
            conn,
            `GET @WAHOOWEST.PUBLIC.QUESTIONS_IMG/${actual} file://${tmpDir}/`
          );

          // Find the downloaded file (case-insensitive)
          let localPath = path.join(tmpDir, actual);
          if (!fs.existsSync(localPath)) {
            localPath = path.join(tmpDir, actual.toLowerCase());
          }
          if (!fs.existsSync(localPath)) {
            const files = fs.readdirSync(tmpDir);
            const match = files.find((f) => f.toLowerCase() === actual.toLowerCase());
            if (match) localPath = path.join(tmpDir, match);
          }

          if (fs.existsSync(localPath)) {
            const bytes = fs.readFileSync(localPath);
            const b64 = bytes.toString("base64");
            this.imageCache.set(imgName.toLowerCase(), b64);
            console.log(`[ROOM] Cached ${imgName} (${bytes.length} bytes)`);
          }
        } catch (e: any) {
          console.log(`[ROOM] Failed to download ${imgName}: ${e.message}`);
        }
      }
      console.log(`[ROOM] Image cache: ${this.imageCache.size} images ready`);
    } finally {
      conn.destroy(() => {});
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /* ── Utility ───────────────────────────────────────────── */

}
