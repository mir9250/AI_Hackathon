
from pathlib import Path
from fastapi import FastAPI
from fastapi.responses import FileResponse
from pydantic import BaseModel

app = FastAPI()


# 프론트엔드 HTML 파일 전달
@app.get("/")
def home():
    return FileResponse(Path(__file__).with_name("index.html"))


# GET API: 프론트엔드에 메시지 보내기
@app.get("/api/hello")
def hello():
    return {"message": "안녕! 백엔드에서 보낸 메시지야."}


# POST API: 프론트엔드에서 받은 데이터 처리
class Message(BaseModel):
    text: str


@app.post("/api/echo")
def echo(data: Message):
    return {"reply": f"백엔드가 받은 글: {data.text}"}
