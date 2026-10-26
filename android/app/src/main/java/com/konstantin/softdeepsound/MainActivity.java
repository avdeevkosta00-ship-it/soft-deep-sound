package com.konstantin.softdeepsound;

import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MusicLibraryPlugin.class);
        registerPlugin(MediaControlsPlugin.class);
        super.onCreate(savedInstanceState);
        // until the page paints, the window shows this colour: the last theme's, so a dark theme does not flash white (or black)
        int bg = getSharedPreferences("sds", 0).getBoolean("light", true) ? 0xFFEEF3FB : 0xFF07070A;
        getWindow().getDecorView().setBackgroundColor(bg);
        getBridge().getWebView().setBackgroundColor(bg);
        // «Back» goes to the page first (closes the player screen, a dialog…); on the main screen
        // the page asks to hide the app like other music players do, so the music keeps going
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() { getBridge().triggerDocumentJSEvent("sdsback"); }
        });
    }
}
