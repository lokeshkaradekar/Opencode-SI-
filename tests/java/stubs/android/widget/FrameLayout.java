package android.widget;
import android.content.Context; import android.view.View; import android.view.ViewGroup;
public class FrameLayout extends ViewGroup { public FrameLayout(Context c){} public void addView(View v){} public void addView(View v, LayoutParams p){} public void removeView(View v){} public static class LayoutParams extends ViewGroup.LayoutParams { public int gravity; public LayoutParams(int w,int h){super(w,h);} public LayoutParams(int w,int h,int g){super(w,h);gravity=g;} } }
