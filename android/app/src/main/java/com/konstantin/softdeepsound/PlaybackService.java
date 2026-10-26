package com.konstantin.softdeepsound;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.IBinder;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.media.app.NotificationCompat.MediaStyle;

/**
 * Keeps the music going when the screen is off or another app is open, and shows the player
 * in the notification shade, on the lock screen and to headset buttons (a MediaSession).
 * The sound itself still comes from the WebView; this service only mirrors its state and
 * sends the buttons back to the page (MediaControlsPlugin → «command» events).
 */
public class PlaybackService extends Service {

    interface Listener { void onCommand(String cmd, double pos); }

    static PlaybackService instance;
    static Listener listener;
    /** the state to show as soon as the service starts */
    static Info pending;

    static class Info {
        String title = "", artist = "", album = "", cover;
        boolean playing;
        double position, duration, rate = 1;
    }

    private static final String CHANNEL = "playback";
    private static final int ID = 1;
    private MediaSessionCompat session;
    private Info info = new Info();
    private String artPath;
    private Bitmap art;
    private boolean foreground;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.playback_channel), NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
        session = new MediaSessionCompat(this, "SoftDeepSound");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { send("play", 0); }
            @Override public void onPause() { send("pause", 0); }
            @Override public void onStop() { send("pause", 0); }
            @Override public void onSkipToNext() { send("next", 0); }
            @Override public void onSkipToPrevious() { send("prev", 0); }
            @Override public void onSeekTo(long pos) { send("seek", pos / 1000.0); }
        });
        session.setSessionActivity(openApp());
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (pending != null) { info = pending; pending = null; }
        String action = intent != null ? intent.getAction() : null;
        if (action != null) send(action, 0);
        render();
        return START_NOT_STICKY;
    }

    static void send(String cmd, double pos) {
        if (listener != null) listener.onCommand(cmd, pos);
    }

    void apply(Info next) {
        info = next;
        render();
    }

    private void render() {
        if (info.cover != null && !info.cover.equals(artPath)) {
            artPath = info.cover;
            art = BitmapFactory.decodeFile(info.cover);
        } else if (info.cover == null) { artPath = null; art = null; }

        session.setMetadata(new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, info.title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, info.artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, info.album)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, (long) (info.duration * 1000))
            .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art)
            .build());
        session.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE | PlaybackStateCompat.ACTION_PLAY_PAUSE
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS | PlaybackStateCompat.ACTION_SEEK_TO)
            .setState(info.playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                (long) (info.position * 1000), info.playing ? (float) info.rate : 0f)
            .build());

        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_sds)
            .setContentTitle(info.title)
            .setContentText(info.artist)
            .setLargeIcon(art)
            .setContentIntent(openApp())
            .setDeleteIntent(command("pause"))
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .addAction(android.R.drawable.ic_media_previous, getString(R.string.cmd_prev), command("prev"))
            .addAction(info.playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                getString(info.playing ? R.string.cmd_pause : R.string.cmd_play), command(info.playing ? "pause" : "play"))
            .addAction(android.R.drawable.ic_media_next, getString(R.string.cmd_next), command("next"))
            .setStyle(new MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2))
            .build();

        // A foreground service from the first played track until the app goes away, paused or not: Android does not
        // let an app in the background become foreground again, so leaving it on pause would make «play» from a
        // headset or the lock screen crash the app (found by the stress test)
        if (!foreground) {
            try {
                ServiceCompat.startForeground(this, ID, n, Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0);
                foreground = true;
            } catch (Exception e) {
                // not allowed right now (the app is in the background): show the player anyway, try again on the next update
                getSystemService(NotificationManager.class).notify(ID, n);
            }
        } else {
            getSystemService(NotificationManager.class).notify(ID, n);
        }
    }

    private PendingIntent command(String cmd) {
        Intent i = new Intent(this, PlaybackService.class).setAction(cmd);
        return PendingIntent.getService(this, cmd.hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** the app was swiped away from recents: the page with the sound is gone, so is the player */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopEverything();
    }

    void stopEverything() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        getSystemService(NotificationManager.class).cancel(ID);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        session.setActive(false);
        session.release();
        instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
