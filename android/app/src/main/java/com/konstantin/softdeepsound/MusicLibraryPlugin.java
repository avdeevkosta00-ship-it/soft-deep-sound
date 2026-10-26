package com.konstantin.softdeepsound;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Size;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * The phone's music, read from Android's own media library (MediaStore): titles, artists, albums and
 * lengths come from the system index, album artwork is saved once as a small JPEG in the app cache.
 * Audio files are only read, never changed; the WebView plays them through Capacitor's local server.
 */
@CapacitorPlugin(
    name = "MusicLibrary",
    permissions = {
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
    }
)
public class MusicLibraryPlugin extends Plugin {

    /** Android 13+ asks for «music and audio», older versions for the whole storage */
    private String alias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? "audio" : "storage";
    }

    @PluginMethod
    public void scan(PluginCall call) {
        if (getPermissionState(alias()) != PermissionState.GRANTED) {
            requestPermissionForAlias(alias(), call, "afterPermission");
            return;
        }
        doScan(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        if (getPermissionState(alias()) == PermissionState.GRANTED) doScan(call);
        else call.reject("permission-denied", "permission-denied");
    }

    private void doScan(PluginCall call) {
        ContentResolver cr = getContext().getContentResolver();
        Uri base = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        String[] cols = {
            MediaStore.Audio.Media._ID, MediaStore.Audio.Media.TITLE, MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.ALBUM, MediaStore.Audio.Media.ALBUM_ID, MediaStore.Audio.Media.DURATION,
            MediaStore.Audio.Media.DATA, MediaStore.Audio.Media.MIME_TYPE, MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.YEAR, MediaStore.Audio.Media.DATE_ADDED
        };
        // ringtones, notifications and voice recorder clips are not music
        String where = MediaStore.Audio.Media.IS_MUSIC + " != 0 AND " + MediaStore.Audio.Media.DURATION + " >= 20000";
        File coverDir = new File(getContext().getCacheDir(), "covers");
        coverDir.mkdirs();
        Map<Long, String> covers = new HashMap<>();
        JSArray tracks = new JSArray();
        try (Cursor c = cr.query(base, cols, where, null, MediaStore.Audio.Media.DATE_ADDED + " DESC")) {
            if (c != null) {
                while (c.moveToNext()) {
                    String path = c.getString(6);
                    if (path == null || !new File(path).canRead()) continue;
                    long albumId = c.getLong(4);
                    if (!covers.containsKey(albumId)) covers.put(albumId, cover(cr, albumId, coverDir));
                    JSObject t = new JSObject();
                    t.put("id", "a" + c.getLong(0));
                    t.put("path", path);
                    t.put("title", c.getString(1));
                    t.put("artist", unknown(c.getString(2)));
                    t.put("album", unknown(c.getString(3)));
                    t.put("duration", c.getLong(5) / 1000.0);
                    t.put("mime", c.getString(7));
                    t.put("size", c.getLong(8));
                    t.put("year", c.getInt(9) > 0 ? c.getInt(9) : null);
                    t.put("addedAt", c.getLong(10) * 1000);
                    t.put("cover", covers.get(albumId));
                    tracks.put(t);
                }
            }
        } catch (Exception e) {
            call.reject(e.getMessage());
            return;
        }
        JSObject res = new JSObject();
        res.put("tracks", tracks);
        call.resolve(res);
    }

    /** MediaStore writes "<unknown>" where a tag is missing */
    private static String unknown(String s) {
        return s == null || s.equals("<unknown>") ? "" : s;
    }

    /** the album's artwork as a cached JPEG, or null when the album has none */
    private String cover(ContentResolver cr, long albumId, File dir) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null;
        File f = new File(dir, albumId + ".jpg");
        if (f.exists()) return f.length() > 0 ? f.getAbsolutePath() : null;
        try {
            Uri album = ContentUris.withAppendedId(MediaStore.Audio.Albums.EXTERNAL_CONTENT_URI, albumId);
            Bitmap b = cr.loadThumbnail(album, new Size(512, 512), null);
            try (FileOutputStream out = new FileOutputStream(f)) { b.compress(Bitmap.CompressFormat.JPEG, 88, out); }
            return f.getAbsolutePath();
        } catch (Exception e) {
            try { f.createNewFile(); } catch (Exception ignored) {} // remember "no artwork" so the next scan is quick
            return null;
        }
    }

    /** a track from the open-sources web search into Music/Soft&Deep Sound (SafeDownload checks everything); progress as «download» events */
    @PluginMethod
    public void download(PluginCall call) {
        String id = call.getString("id", ""), url = call.getString("url", ""), referer = call.getString("referer"), name = call.getString("name", "track");
        new Thread(() -> {
            try {
                String path = SafeDownload.run(getContext(), url, referer, name, (received, total) -> {
                    JSObject o = new JSObject();
                    o.put("id", id); o.put("received", received); o.put("total", total);
                    notifyListeners("download", o);
                });
                JSObject res = new JSObject();
                res.put("path", path);
                call.resolve(res);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }, "sds-download").start();
    }

    @PluginMethod
    public void exists(PluginCall call) {
        JSArray paths = call.getArray("paths");
        JSArray out = new JSArray();
        try {
            for (int i = 0; i < paths.length(); i++) out.put(new File(paths.getString(i)).canRead());
        } catch (Exception e) {
            call.reject(e.getMessage());
            return;
        }
        JSObject res = new JSObject();
        res.put("exists", out);
        call.resolve(res);
    }
}
