const express = require("express");
const cors = require("cors");
const ytdl = require("@distube/ytdl-core");
const ytpl = require("ytpl");
const archiver = require("archiver");
const PromiseBlue = require("bluebird");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { pipeline } = require("stream/promises");
const compression = require("compression");
const rateLimit = require("express-rate-limit");

require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

app.use(compression());

// Apply rate limit only for download route
const downloadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: "Too many download requests, try later.",
});
app.use("/api/download-all", downloadLimiter);

const isPlaylist = (url) => url.includes("list=");

app.get("/", (req, res) => {
  return res.status(200).json({ message: "Hello from the backend!" });
});
app.get("/api/test", (req, res) => {
  return res.status(200).json({ message: "Hello from the backend!" });
});

app.get("/api/formats", async (req, res) => {
  const { url, formatType = "both" } = req.query;

  if (!ytdl.validateURL(url)) {
    return res.status(400).json({ error: "Invalid URL" });
  }

  try {
    const info = await ytdl.getInfo(url);
    const title = info.videoDetails.title;
    const thumbnail =
      info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1].url;
    const duration = info.videoDetails.lengthSeconds;

    let audioFormats = [];
    let videoFormats = [];
    let cleanAudio = [];
    let cleanVideo = [];

    if (formatType === "audio" || formatType === "both") {
      audioFormats = ytdl.filterFormats(info.formats, "audioonly");
      cleanAudio = audioFormats.map((f) => ({
        itag: f.itag,
        quality: f.audioBitrate + " kbps",
        mime: f.mimeType,
      }));
    }

    if (formatType === "video" || formatType === "both") {
      videoFormats = ytdl.filterFormats(info.formats, "videoandaudio");
      cleanVideo = videoFormats.map((f) => ({
        itag: f.itag,
        quality: f.qualityLabel,
        mime: f.mimeType,
      }));
    }

    res.json({
      title,
      thumbnail,
      duration,
      ...(cleanAudio.length > 0 ? { audio: cleanAudio } : {}),
      ...(cleanVideo.length > 0 ? { video: cleanVideo } : {}),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch formats", details: err });
  }
});

app.get("/api/download", async (req, res) => {
  const { url, itag } = req.query;

  if (!ytdl.validateURL(url)) {
    return res.status(400).json({ error: "Invalid URL" });
  }

  try {
    const info = await ytdl.getInfo(url);
    const format = ytdl.chooseFormat(info.formats, { quality: itag });
    const title = info.videoDetails.title.replace(/[^\w\s]/gi, "");

    const ext = format.mimeType.includes("audio") ? "mp3" : "mp4";
    res.header("Content-Disposition", `attachment; filename="${title}.${ext}"`);

    ytdl(url, { format }).pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Download failed", details: err.message });
  }
});

// tiny safe filename helper
const sanitize = (s) =>
  s
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);

app.get("/api/download-all", async (req, res) => {
  const { url, formatType } = req.query;

  if (!url || !isPlaylist(url)) {
    return res.status(400).json({ error: "Invalid playlist URL" });
  }

  try {
    const playlist = await ytpl(url, { pages: Infinity });

    if (!playlist.items?.length) {
      return res.status(404).json({ error: "Empty playlist" });
    }

    if (playlist.items.length > process.env.MAX_PLAYLIST_ITEMS) {
      return res.status(400).json({ error: "Playlist too large" });
    }

    // Start streaming ZIP to client immediately
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="playlist_${Date.now()}.zip"`
    );

    const archive = archiver("zip", {
      zlib: { level: 0 }, // default compression; we'll STORE entries below
      forceZip64: true, // handle very large archives safely
    });

    archive.on("warning", (err) => {
      // log non-fatal warnings (e.g. ENOENT)
      console.warn("archiver warning:", err);
    });

    archive.on("error", (err) => {
      console.error("archiver error:", err);
      // If archiver errors, end the response
      try {
        res.statusCode = 500;
      } catch {}
      res.end();
    });

    archive.pipe(res);

    // Temp working dir for staged files
    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ytzip-"));

    // Choose a sane concurrency (tune 3–6 based on your server/network)
    const CONCURRENCY = Math.min(
      process.env.CONCURRENCY,
      playlist.items.length
    );

    await PromiseBlue.map(
      playlist.items,
      async (item, idx) => {
        try {
          const vurl = item.shortUrl || item.url;
          const info = await ytdl.getInfo(vurl);
          const quality =
            formatType === "video" ? "highestvideo" : "highestaudio";
          const chosen = ytdl.chooseFormat(info.formats, { quality });
          if (!chosen) return;

          const ext = chosen.mimeType.includes("audio") ? "mp3" : "mp4";
          const filename = `${String(idx + 1).padStart(3, "0")} - ${sanitize(
            info.videoDetails.title
          )}.${ext}`;

          const tmpPath = path.join(workDir, `${Date.now()}-${idx}.${ext}`);

          // Stream YouTube -> temp file (no giant in-memory buffers)
          await pipeline(
            ytdl(vurl, { format: chosen, highWaterMark: 1 << 20 }), // 1MB buffer
            fs.createWriteStream(tmpPath)
          );

          // Queue file into the ZIP; use "store" to skip recompression
          archive.file(tmpPath, { name: filename, store: true });
        } catch (err) {
          console.error(`Failed to process ${item.title}:`, err.message);
        }
      },
      { concurrency: CONCURRENCY }
    );

    // No more entries will be added; finish the ZIP
    archive.finalize();

    // Cleanup temp dir when the archive stream is done
    const cleanup = async () =>
      fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    res.on("close", cleanup);
    archive.on("end", cleanup);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Failed to create ZIP", details: err.message });
  }
});

function parseDurationToSeconds(durStr) {
  if (!durStr) return null;
  const parts = durStr.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1]; // mm:ss
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]; // hh:mm:ss
  return null;
}

app.get("/api/playlist-formats", async (req, res) => {
  const { url, formatType = "both" } = req.query;
  if (!url) return res.status(400).json({ error: "URL required" });
  if (!isPlaylist(url)) {
    return res.status(400).json({ error: "Not a playlist URL" });
  }

  try {
    const playlist = await ytpl(url, { pages: Infinity });

    const videos = await Promise.all(
      playlist.items.map(async (item) => {
        try {
          const info = await ytdl.getInfo(item.shortUrl || item.url);

          let bestVideo = null;
          let bestAudio = null;

          if (formatType === "video" || formatType === "both") {
            bestVideo = ytdl.chooseFormat(info.formats, {
              quality: "highestvideo",
            });
          }

          if (formatType === "audio" || formatType === "both") {
            bestAudio = ytdl.chooseFormat(info.formats, {
              quality: "highestaudio",
            });
          }

          return {
            title: item.title,
            url: item.shortUrl || item.url,
            thumbnail: item.bestThumbnail?.url || null,
            duration: parseDurationToSeconds(item.duration) ?? null,
            ...(bestVideo ? { bestVideoItag: bestVideo.itag } : {}),
            ...(bestAudio ? { bestAudioItag: bestAudio.itag } : {}),
          };
        } catch (err) {
          console.error(
            `Failed to fetch formats for ${item.url}:`,
            err.message
          );
          return {
            title: item.title,
            url: item.shortUrl || item.url,
            thumbnail: item.bestThumbnail?.url || null,
            duration: parseDurationToSeconds(item.duration) ?? null,
            bestVideoItag: null,
            bestAudioItag: null,
          };
        }
      })
    );

    res.json(videos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch playlist" });
  }
});

app.listen(process.env.PORT || 4000, () =>
  console.log("Server started on http://localhost:" + process.env.PORT)
);
