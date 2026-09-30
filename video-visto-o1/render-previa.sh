#!/bin/bash
set -e
S=/tmp/claude-0/-home-user-sendflow-notion/4fd6fb69-6bef-5360-b21d-b3f97a9e21b2/scratchpad; cd $S/prev; F=$S/fonts; I=$S/img
BB=$F/BebasNeue.ttf; MX=$F/Montserrat-ExtraBold.ttf; IR=$F/Inter-Regular.ttf
OR=0xFF5A36
EX="(1-min(1\,t/0.6))*(1-min(1\,t/0.6))"
ffmpeg -loglevel error -y -f lavfi -i "color=black:s=1920x1080,format=rgba" -vf "geq=r=0:g=0:b=0:a='if(gt(Y,640),min(215,(Y-640)*0.55),0)'" -frames:v 1 grad.png
seg(){ printf '%s' "$4" > $1.k; printf '%s' "$5" > $1.t1; printf '%s' "$6" > $1.t2; d=$3
ffmpeg -loglevel error -y -loop 1 -framerate 30 -t $d -i "$2" -i grad.png -filter_complex "
[0:v]split[a][b];
[a]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=45,eq=brightness=-0.22:saturation=0.8[bg];
[b]scale=-2:1000[fg];
[bg][fg]overlay=(W-w)/2:40,scale=3840:2160,zoompan=z='1+0.0007*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30[c];
[c][1:v]overlay=0:0,
drawbox=x=96:y=ih-238:w=6:h=150:color=$OR@1:t=fill,
drawtext=fontfile=$MX:textfile=$1.k:fontsize=26:fontcolor=$OR:x=128-60*$EX:y=h-238:alpha=min(1\,t/0.4),
drawtext=fontfile=$MX:textfile=$1.t1:fontsize=64:fontcolor=white:x=126-90*$EX:y=h-200:alpha=min(1\,t/0.5),
drawtext=fontfile=$IR:textfile=$1.t2:fontsize=32:fontcolor=0xE6E6E6:x=128-120*$EX:y=h-122:alpha=min(1\,max(0\,(t-0.15)/0.5)),
format=yuv420p[v]" -map "[v]" -r 30 -c:v libx264 -crf 20 -t $d $1.mp4; }
printf 'HOTMART FIRE 2026' > T.k; printf 'RODRIGO ALMEIDA' > T.a; printf 'Invited Guest' > T.b
ffmpeg -loglevel error -y -loop 1 -framerate 30 -t 4 -i "$I/IMG_6911.jpg" -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=35,eq=brightness=-0.42:saturation=0.7,
drawtext=fontfile=$MX:textfile=T.k:fontsize=30:fontcolor=$OR:x=(w-tw)/2:y=(h/2)-190:alpha=min(1\,t/0.6),
drawtext=fontfile=$BB:textfile=T.a:fontsize=210:fontcolor=white:x=(w-tw)/2:y=(h/2)-140+40*$EX:alpha=min(1\,max(0\,(t-0.2)/0.6)),
drawbox=x=(iw/2)-70:y=(ih/2)+90:w=140:h=5:color=$OR@1:t=fill,
drawtext=fontfile=$IR:textfile=T.b:fontsize=46:fontcolor=0xEEEEEE:x=(w-tw)/2:y=(h/2)+120:alpha=min(1\,max(0\,(t-0.7)/0.6)),format=yuv420p" -r 30 -c:v libx264 -crf 20 s0.mp4
seg s1 "$I/IMG_6911.jpg" 4 "THE EVENT" "Hotmart FIRE 2026" "Official guest credentials at the event entrance"
seg s2 "$I/IMG_6901.JPG" 3 "CREDENTIAL" "Guest Access" "Rodrigo Almeida  ·  Brazil  ·  Hotmart"
seg s3 "$I/IMG_6862.jpg" 3 "VIP AREA" "Hotmart FIRE 2026" "Networking with digital business leaders"
seg s4 "$I/IMG_6863.jpg" 3 "VIP AREA" "Hotmart FIRE 2026" "Networking with digital business leaders"
seg s5 "$I/IMG_6864.jpg" 3 "VIP AREA" "Hotmart FIRE 2026" "Networking with digital business leaders"
printf 'EM BREVE' > P.k; printf 'TRECHOS EM VÍDEO' > P.a; printf 'Rodrigo falando  ›  Depoimentos  ›  Fechamento' > P.b
ffmpeg -loglevel error -y -f lavfi -i color=c=0x0E0E10:s=1920x1080:r=30:d=3 -vf "drawtext=fontfile=$MX:textfile=P.k:fontsize=28:fontcolor=$OR:x=(w-tw)/2:y=(h/2)-130,drawtext=fontfile=$BB:textfile=P.a:fontsize=150:fontcolor=white:x=(w-tw)/2:y=(h/2)-90,drawtext=fontfile=$IR:textfile=P.b:fontsize=38:fontcolor=0xBBBBBB:x=(w-tw)/2:y=(h/2)+80,format=yuv420p" -c:v libx264 -crf 20 s6.mp4
ffmpeg -loglevel error -y -i s0.mp4 -i s1.mp4 -i s2.mp4 -i s3.mp4 -i s4.mp4 -i s5.mp4 -i s6.mp4 -filter_complex "
[0][1]xfade=transition=fade:duration=0.5:offset=3.5[x1];[x1][2]xfade=transition=fade:duration=0.5:offset=7[x2];
[x2][3]xfade=transition=fade:duration=0.5:offset=9.5[x3];[x3][4]xfade=transition=fade:duration=0.5:offset=12[x4];
[x4][5]xfade=transition=fade:duration=0.5:offset=14.5[x5];[x5][6]xfade=transition=fade:duration=0.5:offset=17,format=yuv420p[v]" -map "[v]" -c:v libx264 -crf 21 -movflags +faststart /home/user/sendflow-notion/video-visto-o1/previa-estilo-video-O1.mp4
for t in 2.5 6 11 18.8; do ffmpeg -loglevel error -y -ss $t -i /home/user/sendflow-notion/video-visto-o1/previa-estilo-video-O1.mp4 -frames:v 1 -vf scale=960:-2 g_$t.jpg; done; echo ok
