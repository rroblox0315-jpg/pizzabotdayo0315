FROM node:20-slim

# 音声処理(ffmpeg)とC++ビルド用ツールをインストール
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    make \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./

# エラーを防止して確実にインストール
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["npm", "start"]