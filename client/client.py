import socket
import threading
import json
from protocols import Protocols

class Client:
    # player initialization
    def __init__(self, host = "127.0.0.1", port = 8080):
            self.nickname = None
            self.client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.client.connect((host, port))

            self.closed = False
            self.started = False
            self.questions = []
            self.current_question_index = 0
            self.opponent_question_index = 0
            self.opponent_name = None
            self.winner = None

    # creates thread for receive method to handle server data
    def start(self):
        receive_thread = threading.Thread(target = self.receive)
        receive_thread.start()
    
    # sends data to server
    def send(self, request, message):
        data = {"type": request, "data": message}
        self.server.send(json.dumps(data).encode("ascii"))

    # keeps running to retrieve data from server, until "session" ends
    def receive(self):
        while not self.closed:
            try:
                data = self.client.recv(1024).decode("ascii")
                message = json.loads(data)
                self.handle_response(message)
            except:
                break  

        self.close()  
    
    # just closes player session
    def close(self):
        self.closed = True
        self.client.close() # closes socket connection
    
    # validates user answer
    # idk if this just pertains to the math that ts video was doing, or if we can modify it to include whatever else we're including
    def client_validate_answer(self, attempt):
        question = self.get_current_question
        answer = eval(question)
        if answer == int(attempt):
            self.current_question_index += 1

    # handle data received, and act accordingly
    def handle_response(self, response):
        r_type = response.get("type")
        data = response.get("data")

        if r_type == Protocols.Response.QUESTIONS:
            self.questions = data
        elif r_type == Protocols.Response.OPPONENT:
            self.opponent_name = data
        elif r_type == Protocols.Response.OPPONENT_ADVANCE:
            self.opponent_question_index += 1
        elif r_type == Protocols.Response.START:
            self.started = True
        elif r_type == Protocols.Response.WINNER:
            self.winner = data
            self.close()
        elif r_type == Protocols.Response.OPPONENT_DISCONNECTED:
            self.close()  

    def get_current_question(self):
        # check to avoid index OOB exceptions
        if self.current_question_index >= len(self.questions):
            return ""
        return self.questions[self.current_question_index]