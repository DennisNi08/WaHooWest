import pygame
from client import Client
from protocols import Protocols

# could use ts for SAT part?
# this file is mostly for front end stuff
class MathGame:
    def __init__(self, client):
        self.client = client
        client.start()

        self.font = None
        self.input_box = pygame.Rect(100, 100, 400, 45)
        self.color_inactive = pygame.Color("lightskyblue3")
        self.color_active = pygame.Color("dodgerblue2")
        self.color = self.color_inactive

        self.text = ""
        self.done = False
        self.logged_in = False

    # helps with submitting a name and finding an opponent
    def handle_event(self, event):
        if event.type == pygame.MOUSEBUTTONDOWN:
            if self.input_box.collidepoint(event.pos):
                self.color = self.color_active
            else:
                self.color = self.color_inactive

        if event.type != pygame.KEYDOWN or self.color == self.color_inactive:
            return 

        if event.key == pygame.K_BACKSPACE:
            self.text = self.text[:-1]
        
        elif event.key == pygame.K_RETURN:  # <--- ADD THIS SECTION
            if self.text.strip() != "":
                # If not logged in, send the nickname
                if not self.logged_in:
                    self.client.send(self.text) # Or whatever your login method is
                    self.logged_in = True
                else:
                    # If in game, send the answer
                    self.client.send(self.text)
                
                self.text = "" # Clear the box after hitting enter
        
        else:
            # Only add text if it's NOT the enter key
            self.text += event.unicode
        
    def draw(self, screen):
        screen.fill((255, 255, 255))
        if not self.logged_in and not self.client.started:
            self.draw_login(screen)
        elif not self.client.started:
            self.draw_waiting(screen)
        else:
            self.draw_game(screen)

        pygame.display.update()

    def draw_login(self, screen):
        prompt = "Enter a Nickname"
        prompt_surface = self.font.render(prompt, 1, (0, 0, 0))
        screen.blit(prompt_surface, (100, 50))

        pygame.draw.rect(screen, self.color, self.input_box, 2)
        txt_surface = self.font.render(self.text, 1, self.color)
        screen.blit(txt_surface, (self.input_box.x + 5, self.input_box.y + 5))
        self.input_box.w = max(100, txt_surface.get_width() + 10)

    def draw_waiting(self, screen):
        text = 'Waiting for player'
        text_surface = self.font.render(text, True, (0, 0, 0))
        #draws from the middle of the screen
        screen.blit(text_surface, (screen.getWidth()/2 - text_surface.get_width()/2, screen.getHeight()/2 - text_surface.get_height()/2))

    def draw_game(self, screen):
        question = self.client.get_current_question()
        question_surface = self.font.render(f"{self.client.current_question_index+1}: {question} = ",1, (0, 0, 0))
        screen.blit(question_surface, (100, 50))
        self.draw_opponent_data(screen)
        self.draw_input(screen)

    def draw_opponent_data(self, screen):
        if not self.client.opponent_name:
            return
        
        name_surface = self.font.render(f"Opponent: {self.client.opponent_name}", 1, (0, 0, 0))
        screen.blit(name_surface, (550,50))
        
        question_num = self.client.get_opponent_question_index()
        question_surface = self.font.render(f"Question: {question_num}", 1, (0, 0, 0))
        screen.blit(question_surface, (550, 100))
        
    def handle_end(self, screen):
        run = True
        while run:
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    run = False
            if self.client.won:
                text = f"{self.client.winner} won!"
            else:
                text = f"Opponent left the game....."
            text_surface = self.font.render(text, True, (0, 0, 0))
            screen.blit(text_surface, (screen.getWidth()/2 - text_surface.get_width()/2, screen.getHeight()/2 - text_surface.get_height()/2))
            pygame.display.update()

    def run(self):
        pygame.init()
        screen = pygame.display.set_mode((800, 600)) # creates screen
        clock = pygame.time.Clock()
        self.font = pygame.font.SysFont("comicsans", 32)

        while not self.client.closed:
            clock.tick(30)
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    self.client.close()
                    pygame.quit()
                else:
                    self.handle_event(event)

            self.draw(screen)
        self.handle_end(screen)
        pygame.quit()

if __name__ == "__main__":
    game = MathGame(Client())
    game.run()