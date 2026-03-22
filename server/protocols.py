class Protocols:
    class Response:
        NICKNAME = "protocols.response.nickname"
        QUESTIONS = "protocols.questions"
        START = "protocols.start"
        OPPONENT = " protocols.opponent"
        OPPONENT_ADVANCE = "protocols.opponent.advance"
        ANSWER_VALID = "protocols.answer.valid"
        ANSWER_INVALID = "protocols.answer.invalid"
        WINNER = "protocols.winner"
        OPPONENT_DISCONNECTED = "protocols.opponent.disconnected"
        
    class Request:
        ANSWER = "protocols.answer"
        NICKNAME = "protocols.nickname"
        LEAVE = "protocols.leave"