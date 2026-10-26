package com.konstantin.softdeepsound;

import android.content.Intent;

import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** The page tells what is playing; buttons from the notification, lock screen and headset come back as «command» events. */
@CapacitorPlugin(name = "MediaControls")
public class MediaControlsPlugin extends Plugin {

    @Override
    public void load() {
        PlaybackService.listener = (cmd, pos) -> {
            JSObject o = new JSObject();
            o.put("cmd", cmd);
            o.put("pos", pos);
            notifyListeners("command", o, true);
        };
    }

    @PluginMethod
    public void update(PluginCall call) {
        PlaybackService.Info i = new PlaybackService.Info();
        i.title = call.getString("title", "");
        i.artist = call.getString("artist", "");
        i.album = call.getString("album", "");
        i.cover = call.getString("cover");
        i.playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
        i.position = call.getDouble("position", 0.0);
        i.duration = call.getDouble("duration", 0.0);
        i.rate = call.getDouble("rate", 1.0);
        PlaybackService s = PlaybackService.instance;
        if (s != null) getActivity().runOnUiThread(() -> s.apply(i));
        else if (i.playing) {
            // the service starts with the first played track; before that there is nothing to show
            PlaybackService.pending = i;
            try { ContextCompat.startForegroundService(getContext(), new Intent(getContext(), PlaybackService.class)); }
            catch (Exception e) { /* the app is in the background: the next update from the foreground starts it */ }
        }
        call.resolve();
    }

    /** «Back» on the main screen: hide the app, keep it (and the music) alive */
    @PluginMethod
    public void minimize(PluginCall call) {
        getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
        call.resolve();
    }

    /** a link from the page (a lyrics source, the project page) opens in the browser; https only */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://")) { call.reject("https only"); return; }
        Intent i = new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { getContext().startActivity(i); call.resolve(); } catch (Exception e) { call.reject(e.getMessage()); }
    }

    /** status and navigation bar icons: dark on light themes, light on dark ones */
    @PluginMethod
    public void setBars(PluginCall call) {
        boolean light = Boolean.TRUE.equals(call.getBoolean("light", true));
        // remembered for the next start: the window behind the page opens in the same tone (MainActivity)
        getContext().getSharedPreferences("sds", 0).edit().putBoolean("light", light).apply();
        getActivity().runOnUiThread(() -> {
            androidx.core.view.WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getActivity().getWindow(), getActivity().getWindow().getDecorView());
            c.setAppearanceLightStatusBars(light);
            c.setAppearanceLightNavigationBars(light);
        });
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        PlaybackService s = PlaybackService.instance;
        if (s != null) getActivity().runOnUiThread(s::stopEverything);
        call.resolve();
    }
}
