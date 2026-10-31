package com.konstantin.softdeepsound;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URL;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * The phone's counterpart of src/search/downloader.js — the only way remote bytes reach the phone:
 *  - https only, no IP literals / local names, and every redirect hop must resolve to public addresses only
 *  - the server must say it is sending audio (or binary with an audio file extension)
 *  - a hard size cap; the format is read from the first bytes, never trusted from the name
 *  - saved through MediaStore into Music/Soft&Deep Sound (no storage permission needed), never overwriting
 */
class SafeDownload {
    interface Progress { void on(long received, long total); }

    static final long MAX_BYTES = 300L * 1024 * 1024;
    static final String FOLDER = "Soft&Deep Sound";

    /** @return the absolute path of the saved file */
    static String run(Context ctx, String url, String referer, String name, Progress progress) throws Exception {
        HttpURLConnection c = open(url, referer);
        try {
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) throw new Exception("HTTP " + code);
            String type = String.valueOf(c.getContentType()).toLowerCase(Locale.ROOT);
            boolean audioExt = c.getURL().getPath().toLowerCase(Locale.ROOT).matches(".*\\.(mp3|ogg|flac|wav|m4a|opus)$");
            boolean okType = type.startsWith("audio/") || type.contains("ogg")
                || ((type.contains("octet-stream") || type.contains("binary") || type.equals("null")) && audioExt);
            if (!okType) throw new Exception("not-audio " + type);
            long total = c.getContentLengthLong();
            if (total > MAX_BYTES) throw new Exception("too-big");

            // the first bytes decide the format; the rest streams to a temp file in the app cache
            File tmp = File.createTempFile("sds-", ".part", ctx.getCacheDir());
            byte[] head = new byte[16]; int headLen = 0; long received = 0, lastEmit = 0;
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(tmp)) {
                byte[] buf = new byte[64 * 1024]; int n;
                while ((n = in.read(buf)) > 0) {
                    received += n;
                    if (received > MAX_BYTES) throw new Exception("too-big");
                    if (headLen < 16) { int k = Math.min(16 - headLen, n); System.arraycopy(buf, 0, head, headLen, k); headLen += k; }
                    out.write(buf, 0, n);
                    long now = System.currentTimeMillis();
                    if (now - lastEmit > 150) { lastEmit = now; progress.on(received, total); }
                }
            } catch (Exception e) { tmp.delete(); throw e; }
            String ext = sniff(head, headLen);
            if (ext == null) { tmp.delete(); throw new Exception("not-audio-bytes"); }
            try { return save(ctx, tmp, sanitize(name), ext); } finally { tmp.delete(); }
        } finally { c.disconnect(); }
    }

    static final long MAX_IMAGE = 6L * 1024 * 1024;
    /** where album artwork may come from: the Cover Art Archive (and archive.org, where it lives), Deezer's and Apple's CDNs */
    private static final String IMAGE_HOSTS = "(^|.*\\.)(coverartarchive\\.org|archive\\.org|dzcdn\\.net|mzstatic\\.com)$";

    /**
     * Album artwork for the library repair (renderer/js/mb-repair.js) into `out`. Same rules as audio — https,
     * public addresses, every redirect checked — plus a short list of artwork hosts, an image content type
     * and a 6 MB cap. @return the file's path, or null when the server has no such image
     */
    static String image(String url, File out) throws Exception {
        String current = url;
        HttpURLConnection c = null;
        for (int hop = 0; hop <= 6 && c == null; hop++) {
            URL u = new URL(current);
            assertSafe(u);
            if (!u.getHost().toLowerCase(Locale.ROOT).matches(IMAGE_HOSTS)) throw new Exception("blocked host");
            HttpURLConnection h = (HttpURLConnection) u.openConnection();
            h.setInstanceFollowRedirects(false);
            h.setConnectTimeout(15000); h.setReadTimeout(20000);
            h.setRequestProperty("User-Agent", "SoftDeepSound (Android; https://github.com/infallibl3/soft-deep-sound)");
            h.setRequestProperty("Accept", "image/*");
            int code = h.getResponseCode();
            String loc = h.getHeaderField("Location");
            if (code >= 300 && code < 400 && loc != null) { h.disconnect(); current = new URL(u, loc).toString(); continue; }
            c = h;
        }
        if (c == null) throw new Exception("too many redirects");
        try {
            int code = c.getResponseCode();
            if (code == 404) return null;
            if (code != 200) throw new Exception("HTTP " + code);
            String type = String.valueOf(c.getContentType()).toLowerCase(Locale.ROOT);
            if (!type.startsWith("image/")) return null;
            long len = c.getContentLengthLong();
            if (len > MAX_IMAGE) return null;
            File part = new File(out.getPath() + ".part");
            long total = 0;
            try (InputStream in = c.getInputStream(); OutputStream o = new FileOutputStream(part)) {
                byte[] buf = new byte[32 * 1024];
                for (int n; (n = in.read(buf)) > 0; ) {
                    total += n;
                    if (total > MAX_IMAGE) { o.close(); part.delete(); return null; }
                    o.write(buf, 0, n);
                }
            }
            if (total == 0 || !part.renameTo(out)) { part.delete(); return null; }
            return out.getAbsolutePath();
        } finally { c.disconnect(); }
    }

    /** follows redirects by hand so that every hop is checked before it is requested */
    private static HttpURLConnection open(String start, String referer) throws Exception {
        String current = start;
        for (int hop = 0; hop <= 6; hop++) {
            URL u = new URL(current);
            assertSafe(u);
            HttpURLConnection c = (HttpURLConnection) u.openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000); c.setReadTimeout(20000); // 20 s without a single byte: the server has stalled
            c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) SoftDeepSound/1.2");
            c.setRequestProperty("Accept", "audio/*,*/*;q=0.8");
            if (referer != null && referer.startsWith("https://")) c.setRequestProperty("Referer", referer);
            int code = c.getResponseCode();
            String loc = c.getHeaderField("Location");
            if (code >= 300 && code < 400 && loc != null) { c.disconnect(); current = new URL(u, loc).toString(); continue; }
            return c;
        }
        throw new Exception("too many redirects");
    }

    private static void assertSafe(URL u) throws Exception {
        if (!"https".equals(u.getProtocol())) throw new Exception("https only");
        String h = u.getHost().toLowerCase(Locale.ROOT).replaceAll("\\.$", "");
        if (h.equals("localhost") || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")
            || h.matches("^[\\d.]+$") || h.contains(":")) throw new Exception("blocked address");
        InetAddress[] all = InetAddress.getAllByName(h);
        if (all.length == 0) throw new Exception("blocked address");
        for (InetAddress a : all) if (isPrivate(a)) throw new Exception("blocked address");
    }

    /** private, loopback, link-local, carrier-grade NAT, multicast — mirrors isPrivateIp in src/search/http.js */
    static boolean isPrivate(InetAddress a) {
        if (a.isAnyLocalAddress() || a.isLoopbackAddress() || a.isLinkLocalAddress() || a.isSiteLocalAddress() || a.isMulticastAddress()) return true;
        byte[] b = a.getAddress();
        if (a instanceof Inet4Address) {
            int x = b[0] & 0xff, y = b[1] & 0xff;
            return x == 0 || (x == 100 && y >= 64 && y <= 127) || x >= 224;
        }
        if (a instanceof Inet6Address) return (b[0] & 0xfe) == 0xfc; // fc00::/7
        return false;
    }

    static String sniff(byte[] b, int n) {
        if (n < 12) return null;
        String s4 = new String(b, 0, 4, java.nio.charset.StandardCharsets.ISO_8859_1);
        if (s4.startsWith("ID3")) return "mp3";
        if ((b[0] & 0xff) == 0xff && (b[1] & 0xe0) == 0xe0) return "mp3";
        if (s4.equals("fLaC")) return "flac";
        if (s4.equals("OggS")) return "ogg";
        if (s4.equals("RIFF") && new String(b, 8, 4, java.nio.charset.StandardCharsets.ISO_8859_1).equals("WAVE")) return "wav";
        if (new String(b, 4, 4, java.nio.charset.StandardCharsets.ISO_8859_1).equals("ftyp")) return "m4a";
        return null;
    }

    static String sanitize(String s) {
        String out = String.valueOf(s == null ? "" : s).replaceAll("[<>:\"/\\\\|?*\\x00-\\x1f]", "").replaceAll("\\s+", " ").trim();
        if (out.length() > 120) out = out.substring(0, 120);
        return out.isEmpty() ? "track" : out;
    }

    private static String mime(String ext) {
        switch (ext) {
            case "mp3": return "audio/mpeg";
            case "flac": return "audio/flac";
            case "ogg": return "audio/ogg";
            case "wav": return "audio/wav";
            default: return "audio/mp4";
        }
    }

    /** into Music/Soft&Deep Sound; Android renames instead of overwriting; then the media index learns about it */
    private static String save(Context ctx, File tmp, String base, String ext) throws Exception {
        String path;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver cr = ctx.getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.Audio.Media.DISPLAY_NAME, base + "." + ext);
            v.put(MediaStore.Audio.Media.MIME_TYPE, mime(ext));
            v.put(MediaStore.Audio.Media.RELATIVE_PATH, Environment.DIRECTORY_MUSIC + "/" + FOLDER);
            v.put(MediaStore.Audio.Media.IS_PENDING, 1);
            Uri uri = cr.insert(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
            if (uri == null) throw new Exception("cannot save");
            try (OutputStream out = cr.openOutputStream(uri); InputStream in = new java.io.FileInputStream(tmp)) {
                byte[] buf = new byte[64 * 1024]; int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            } catch (Exception e) { cr.delete(uri, null, null); throw e; }
            v.clear(); v.put(MediaStore.Audio.Media.IS_PENDING, 0);
            cr.update(uri, v, null, null);
            try (Cursor q = cr.query(uri, new String[]{ MediaStore.Audio.Media.DATA }, null, null, null)) {
                if (q == null || !q.moveToFirst()) throw new Exception("cannot save");
                path = q.getString(0);
            }
        } else {
            File dir = new File(ctx.getExternalFilesDir(Environment.DIRECTORY_MUSIC), FOLDER);
            dir.mkdirs();
            File f = new File(dir, base + "." + ext);
            for (int i = 2; f.exists(); i++) f = new File(dir, base + " (" + i + ")." + ext);
            try (InputStream in = new java.io.FileInputStream(tmp); OutputStream out = new FileOutputStream(f)) {
                byte[] buf = new byte[64 * 1024]; int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            path = f.getAbsolutePath();
        }
        // the scan fills in the length and tags, so the next library scan sees a complete track
        CountDownLatch done = new CountDownLatch(1);
        MediaScannerConnection.scanFile(ctx, new String[]{ path }, null, (p, u) -> done.countDown());
        done.await(8, TimeUnit.SECONDS);
        return path;
    }
}
