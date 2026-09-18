# 媒体回归样本

`voice-fragmented.mp4` 是本地合成的 1 秒静音 AAC，无用户数据。生成命令：

```sh
ffmpeg -f lavfi -i anullsrc=r=48000:cl=mono -t 1 -c:a aac \
  -movflags frag_keyframe+empty_moov+default_base_moof -frag_duration 500000 \
  voice-fragmented.mp4
ffprobe -v error -show_entries format=duration -of default=nw=1 voice-fragmented.mp4
# duration=1.021333（含 AAC padding）
```

样本有空 moov duration 和多个 moof；测试不依赖本机安装 ffmpeg。
