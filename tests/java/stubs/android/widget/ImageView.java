package android.widget;
import android.content.Context; import android.graphics.Bitmap; import android.view.View;
public class ImageView extends View { public enum ScaleType { FIT_CENTER } public ImageView(Context c){} public void setScaleType(ScaleType t){} public void setImageBitmap(Bitmap b){} public void setContentDescription(CharSequence s){} }
