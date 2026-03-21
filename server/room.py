class Room:
    def __init__(self,client1, client2):
        #generates a set of questions and answers for the game, and stores them in the room. Also creates a dictionary to keep track of each client's progress through the questions, with the client as the key and the index of the current question as the value.
        self.questions, self.answers = self.generate_questions()
        self.indexes = {client1: 0, client2: 0}
        #is the room finished?
        self.finished = False

    def generate_questions(self):
        #generates a set of questions and answers for the game, and stores them in the room. This is just a placeholder, and can be modified to include whatever questions and answers we want.
        questions = ["1 + 1", "2 + 2", "3 + 3", "4 + 4", "5 + 5"]
        answers = [2, 4, 6, 8, 10]
        return questions, answers
    
    def verify_answer(self, client, attempt):
        if self.finished:
            return False
        
        index = self.indexes[client]
        answer = self.answers[index]
        correct = answer == int(attempt)
        if correct:
            self.indexes[client] += 1

            return correct