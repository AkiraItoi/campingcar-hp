from flask import Flask, render_template, request
from datetime import datetime, timedelta
from price_table import PRICE_TABLE, SEASON_PERIODS

app = Flask(__name__)


def get_season(date):
    for period in SEASON_PERIODS:
        start = datetime.strptime(period["start"], "%Y-%m-%d")
        end = datetime.strptime(period["end"], "%Y-%m-%d")

        if start <= date <= end:
            return period["name"]

    return "通常期"


@app.route("/", methods=["GET", "POST"])
def home():
    start_date = None
    end_date = None
    nights = None
    total_price = None
    error = None
    daily_breakdown = []

    if request.method == "POST":
        start_date = request.form.get("start_date")
        end_date = request.form.get("end_date")

        try:
            start = datetime.strptime(start_date, "%Y-%m-%d")
            end = datetime.strptime(end_date, "%Y-%m-%d")

            nights = (end - start).days

            if nights <= 0:
                error = "返却日は出発日より後の日付にしてください。"
                nights = None
            else:
                total_price = 0
                current_date = start

                while current_date < end:
                    season = get_season(current_date)
                    daily_price = PRICE_TABLE[season]

                    total_price += daily_price

                    daily_breakdown.append({
                        "date": current_date.strftime("%Y-%m-%d"),
                        "season": season,
                        "price": daily_price
                    })

                    current_date += timedelta(days=1)

        except ValueError:
            error = "日付の入力内容を確認してください。"

    return render_template(
        "index.html",
        start_date=start_date,
        end_date=end_date,
        nights=nights,
        total_price=total_price,
        error=error,
        price_table=PRICE_TABLE,
        daily_breakdown=daily_breakdown
    )


if __name__ == "__main__":
    app.run(debug=True)