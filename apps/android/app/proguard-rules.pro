# Keep Android entrypoints referenced from AndroidManifest.xml
-keep public class org.dsh.community.android.DshApp
-keep public class org.dsh.community.android.MainActivity
-keep public class org.dsh.community.android.service.RemoteSessionService { *; }

# Keep org.webrtc Java API & JNI native callbacks intact under R8 minification
-keep class org.webrtc.** { *; }
-keep interface org.webrtc.** { *; }
-dontwarn org.webrtc.**
-dontwarn org.jni_zero.**
-dontwarn javax.annotation.**

# Preserve remote transport, crypto, and protocol types cleanly for stacktraces & JNI/service bindings
-keepclassmembers class org.dsh.community.android.transport.** { *; }
-keepclassmembers class org.dsh.community.android.protocol.** { *; }
-keepclassmembers class org.dsh.community.android.crypto.** { *; }

-keepattributes Exceptions,InnerClasses,Signature,RuntimeVisibleAnnotations
