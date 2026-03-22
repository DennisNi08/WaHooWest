import socket
import threading
import json
from protocols import Protocols
import time
from room import Room


class Server:
    def __init__(self, host = "127.0.0.1", port = 64209):
        self.host = host
        self.port = port
        self.server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        # Binds the socket(client) to the host
        self.server_socket.bind((self.host, self.port))
        #allows the server to start listening for clients
        self.server_socket.listen()
        # A dictionary to store the clients and their nicknames
        self.client_names = {}
        # A dictionary to store the rooms and their clients
        self.opponents = {}
        # A dictionary to store the rooms and their questions
        self.rooms={}
        # stores the address of someone waiting to be paired up
        self.waiting_for_pair = None

    #prompted by receive, this will handle the connection of a new client to the server.
    def handle_connect(self, client):
        while True:
            #sends nickname request to client
            self.send(Protocols.Response.NICKNAME, None, client)
            #waits for client to send nickname, then decodes the message and stores it in a variable
            message = json.loads(client.recv(1024).decode("ascii"))
            #stores the type of the message and the data of the message in separate variables
            r_type = message.get("type")
            nickname = message.get("data")

            #checks if the type of the message is a nickname request, if it is, then it stores the client's nickname in the clients dictionary with the client as the key and the nickname as the value. If it is not, then it continues to wait for a valid message from the client.
            if r_type == Protocols.Request.NICKNAME:
                self.client_names[client] = nickname
            else:
                continue

            #if there is no client waiting for a pair, then it sets the waiting_for_pair variable to the current client and waits for another client to connect. If there is a client waiting for a pair, then it connects the two clients together and starts the game.
            if not self.waiting_for_pair:
                self.waiting_for_pair = client
                print("waiting for a room")
            else:
                #connects the two clients together and starts the game
                self.create_room(client)
                print("room created")

            break


    #promted by handle_connect, this will make a room and allow two clients to connect to each other. 
    def create_room(self, client):
        print("Creating Room")
        # creates a room with the client and the waiting_for_pair client, 
        room = Room(client, self.waiting_for_pair)
        # modifies the opponents dictionary to store the opponent of each client, with the client as the key and the opponent as the value.
        self.opponents[client] = self.waiting_for_pair
        self.opponents[self.waiting_for_pair] = client
        #sends a message to both clients that they have been paired up with their opponent, and includes the nickname of their opponent in the message. This will allow the clients to know who they are playing against and start the game.
        self.send(Protocols.Response.OPPONENT, self.client_names[client], self.waiting_for_pair)
        self.send(Protocols.Response.OPPONENT, self.client_names[self.waiting_for_pair], client)
        # modifies the rooms dictionary to store the room of each client, with the client as the key and the room as the value.
        self.rooms[client] = room
        self.rooms[self.waiting_for_pair] = room
        #resets the waiting_for_pair variable to None, since there is no longer a client waiting for a pair.
        self.waiting_for_pair = None

    
    #waiting for room to available, this will be prompted by handle_connect, and will wait for a client to be available to connect to. If there is a client waiting, it will connect the two clients together and start the game. If there is no client waiting, it will set the waiting_for_pair variable to the current client and wait for another client to connect.
    def wait_for_room(self, client):
        while True:
            # checks if there is a client waiting for a pair, if there is, then it creates a room with the current client and the waiting_for_pair client, and starts the game. If there is no client waiting for a pair, then it sets the waiting_for_pair variable to the current client and waits for another client to connect.
            room = self.rooms.get(client)
            opponent = self.opponents.get(client)
        
            if room and opponent:
                self.send(Protocols.Response.QUESTIONS, room.questions, client)
                time.sleep(1)
                self.send(Protocols.Response.START, None, opponent)
                break


    #promted by receive, this will handle the messages sent by the client. This will be run in a separate thread for each client, and will allow the server to handle multiple clients at the same time. This will also allow the server to handle the messages sent by the clients and respond accordingly.
    def handle(self, client):
        #allows person to connect, get username from client
        self.handle_connect(client)
        #waits for the client to be paired up with an opponent, and then sends the questions to the client and starts the game. This will allow the client to know who they are playing against and start the game.
        self.wait_for_room(client)

        #after the game has started, this will wait for the client to send messages, and will handle the messages accordingly. This will allow the server to respond to the client's messages and keep track of the game state. If the client disconnects, then it will break out of the loop and handle the disconnection of the client.
        while True:
            try:
                data = client.recv(1024).decode("ascii")
                if not data :
                    break
                message = json.loads(data)
                self.handle_recieve(message, client)
            except:
                break

        self.send_to_opponent(Protocols.Response.OPPONENT_DISCONNECTED, None, client)
        self.disconnect(client)

    #handle the disconnection of a client
    def disconnect(self, client):
        #gets the client's opponent
        opponent = self.opponents.get(client)
        #removes the client and the opponent from the opponents dictionary, with the client and opponent as the keys and the values. This will allow us to keep track of the clients and their opponents, and allow us to handle the disconnection of a client and their opponent accordingly.
        if opponent in self.opponents:
            del self.opponents[opponent]

        if client in self.opponents:
            del self.opponents[client]

        #removes the client and opponent's nickname from the clients dictionary, with the client and opponent as the keys and the values. This will allow us to keep track of the clients and their nicknames, and allow us to handle the disconnection of a client and their opponent accordingly.
        if client in self.client_names:
            del self.client_names[client]

        if opponent in self.client_names:
            del self.client_names[opponent]

        # removes the client and opponent's room from the rooms dictionary
        if client in self.rooms:
            del self.rooms[client] 

        if opponent in self.rooms:
            del self.rooms[opponent]

        #closes the client's connection to the server. This will allow us to free up resources and allow the server to continue running without any issues.
        client.close()


    #handle recieving a message from a client
    def handle_recieve(self, message,client):
        #stores the type of the message and the data of the message in separate variables
        r_type = message.get("type")
        data = message.get("data")
        #gets the room of the client from the rooms dictionary, with the client as the key and the room as the value. This will allow us to access the questions and answers of the room, and keep track of the client's progress through the questions.
        room = self.rooms.get(client)
        #checks if the type of the message is an answer, if it is, then it verifies the answer and responds accordingly. If it is not, then it continues to wait for a valid message from the client.
        if r_type == Protocols.Request.Answer:
            return 
        # verifies the answer sent by the client, and responds accordingly.
        correct = room.verify_answer(client, data)
        #if the answer is not correct, then it sends a message to the client that the answer is not correctr
        if not correct:
            self.send(Protocols.Response.ANSWER_INVALID, None, client)
            return
        
        #if the answer is correct, then it checks if the client has answered all the questions, if they have, then it sends a message to the client that they have won, and sends a message to the opponent that they have lost. 
        if (room.indexes[client] >= len(room.questions)):
            if not room.finished:
                #update database here
                room.finished = True

            self.send(Protocols.Response.WINNER, None, client)
            self.send_to_opponent(Protocols.Response.WINNER, self.client_names[client], client)

        else:
            #if the answer is correct, but the client has not answered all the questions, then it sends a message to the client that the answer is correct, and sends a message to the opponent that their opponent has advanced to the next question. This will allow the clients to keep track of each other's progress through the questions and make the game more competitive.
            self.send_to_opponent(Protocols.Response.OPPONENT_ADVANCE, None, client)
            self.send(Protocols.Response.ANSWER_VALID, None, client)


    #Sends message to the client itself
    def send(self, r_type, data, client):
        # creates a message dictionary with the type of the message and the data of the message, then converts the message to a JSON string and encodes it to bytes, and sends it to the client. This will allow us to send messages to the client in a structured format, and allow the client to decode the messages and respond accordingly.
        message = {"type": r_type, "data": data}
        message = json.dumps(message).encode("ascii")
        client.send(message)

    #Sends a message to client's opponent
    def send_to_opponent(self, r_type, data, client):
        #gets the opponent of the client from the opponents dictionary, with the client as the key and the opponent as the value. This will allow us to send messages to the opponent of the client, and allow the opponent to respond accordingly.
        opponent = self.opponents.get(client)
        if not opponent:
            return
        self.send(r_type, data, opponent)

    #recieve a new connect, allow a new client to connect to our server. This will have another thread manage the connection to the other server
    #This will allow us to have multiple clients connected to our server at the same time
    def receive(self):
        #want an infinite loop to keep the server running and accepting new clients
        while True:
            #blocks the server until a new client connects, then returns a new socket object representing the connection and the address of the client
            client, address = self.server_socket.accept()
            print(f"New connection from {str(address)}")
            #creates a thread object that will run the handle function with the client as an argument. This will allow us to handle the connection of the new client in a separate thread, so that we can continue to accept new clients while we are handling the connection of the current client.
            thread = threading.Thread(target=self.handle, args=(client,))
            thread.start()

if __name__ == "__main__":
    server = Server()
    print("Server is running...")
    server.receive()